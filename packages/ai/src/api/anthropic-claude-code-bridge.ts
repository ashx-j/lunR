import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_UPDATE_REQUIRED } from "../auth/anthropic-route.ts";
import type { ExternalClaudeCodeCredential } from "../auth/types.ts";
import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { stream as streamMessages, streamSimple as streamSimpleMessages } from "./anthropic-messages.ts";
import { ClaudeCodeLoopback, type ClaudeCodeTool } from "./claude-code-loopback.ts";
import {
	type ClaudeCodeEvent,
	claudeCodeEnvironment,
	claudeCodeEvents,
	spawnClaudeCode,
	stopProcessTree,
	stopProcessTreeSync,
} from "./claude-code-process.ts";

/** MCP server name prefix Claude Code puts on lunR's tools. Stripped again before lunR sees a tool call. */
const TOOL_PREFIX = "mcp__lunr__";
const TOOL_NAME = new RegExp(`^[A-Za-z0-9_-]{1,${64 - TOOL_PREFIX.length}}$`);
const SUPPORTED_PARAMS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"max_tokens",
	"stream",
	"system",
	"tools",
	"thinking",
	"output_config",
	"tool_choice",
]);
const USER_BLOCKS: ReadonlySet<unknown> = new Set(["text", "image", "document", "tool_result"]);
const ASSISTANT_BLOCKS: ReadonlySet<unknown> = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);
const REQUEST_ENV = {
	ENABLE_TOOL_SEARCH: "false",
	CLAUDE_CODE_MAX_RETRIES: "0",
	DISABLE_AUTO_COMPACT: "1",
	DISABLE_COMPACT: "1",
	// lunR owns token budgets; Claude Code's replayed reminder would invalidate cached history.
	CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
} as const;
const NOT_SIGNED_IN = "Claude Code is not signed in to a Claude subscription. Run /login anthropic.";
/** Anthropic's error type for each HTTP status, used when rebuilding an error Claude Code reported. */
const ERROR_TYPES: Readonly<Record<number, string>> = {
	400: "invalid_request_error",
	401: "authentication_error",
	403: "permission_error",
	404: "not_found_error",
	413: "request_too_large",
	429: "rate_limit_error",
	500: "api_error",
	529: "overloaded_error",
};
/** How long Claude Code may keep running after an upstream error before its process tree is killed. */
export const CLAUDE_CODE_EXIT_GRACE_MS = 2500;

export { CLAUDE_CODE_UPDATE_REQUIRED };

type Block = Record<string, unknown>;

/** One stream-json input line: a user or assistant turn Claude Code appends to its transcript. */
interface Frame {
	type: "user" | "assistant";
	message: { role: "user" | "assistant"; model?: string; content: Block[] };
}

/** A Messages request translated into Claude Code's inputs. */
interface ClaudeCodeRequest {
	route: string;
	system: string;
	frames: Frame[];
	tools: ClaudeCodeTool[];
	/** Request fields Claude Code merges into its own Messages request (`CLAUDE_CODE_EXTRA_BODY`). */
	extraBody: Record<string, unknown>;
	maxTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function contentBlocks(content: unknown, allowed: ReadonlySet<unknown>): Block[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) throw new Error("Invalid Claude Code message content");
	return content.map((block) => {
		if (!isRecord(block) || !allowed.has(block.type))
			throw new Error(`Claude Code subscription does not support ${isRecord(block) ? block.type : "this"} content`);
		return block.type === "tool_use" ? { ...block, name: `${TOOL_PREFIX}${block.name}` } : block;
	});
}

/**
 * Turns Messages history into stream-json frames. Consecutive user turns merge, and the history must end
 * with the user turn that asks for the new generation.
 */
function historyFrames(messages: unknown[], model: string): Frame[] {
	const frames: Frame[] = [];
	for (const message of messages) {
		if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant"))
			throw new Error("Invalid Claude Code message");
		const role = message.role;
		const content = contentBlocks(message.content, role === "user" ? USER_BLOCKS : ASSISTANT_BLOCKS);
		const previous = frames.at(-1);
		if (role === "user" && previous?.type === "user") previous.message.content.push(...content);
		else frames.push({ type: role, message: role === "assistant" ? { role, model, content } : { role, content } });
	}
	const last = frames.at(-1);
	if (last?.type !== "user" || !last.message.content.length)
		throw new Error("Claude Code history must end with a user message; assistant prefill is unsupported");
	return frames;
}

/**
 * Validates the request lunR's Messages implementation built and maps it onto Claude Code's inputs. The
 * route is the one setup saved for the model, so Claude Code gets exactly the variant discovery chose.
 */
function claudeCodeRequest(body: unknown, connection: ExternalClaudeCodeCredential): ClaudeCodeRequest {
	if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages))
		throw new Error("Invalid Claude Code request");
	const unsupported = Object.keys(body).filter((key) => !SUPPORTED_PARAMS.has(key));
	if (unsupported.length) throw new Error(`Claude Code subscription does not support ${unsupported.join(", ")}`);
	if (body.tool_choice !== undefined && !(isRecord(body.tool_choice) && body.tool_choice.type === "auto"))
		throw new Error("Claude Code subscription does not support forced tool choice");
	const route = connection.models?.find((model) => model.id === body.model)?.route;
	if (!route) throw new Error(`Claude Code ${body.model} is not available through this subscription connection`);

	const system =
		typeof body.system === "string"
			? body.system
			: Array.isArray(body.system)
				? body.system
						.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
						.join("\n\n")
				: "";

	// Claude Code's MCP names cap the length; one long or unusual tool name is left out rather than failing the turn.
	const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool): ClaudeCodeTool[] =>
		isRecord(tool) && typeof tool.name === "string" && TOOL_NAME.test(tool.name) && isRecord(tool.input_schema)
			? [
					{
						name: tool.name,
						description: typeof tool.description === "string" ? tool.description : "",
						inputSchema: tool.input_schema,
					},
				]
			: [],
	);

	const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
	const thinking = isRecord(body.thinking) ? body.thinking : undefined;
	return {
		route,
		system,
		frames: historyFrames(body.messages, body.model),
		tools,
		maxTokens,
		extraBody: {
			tools: tools.map((tool) => ({
				name: `${TOOL_PREFIX}${tool.name}`,
				description: tool.description,
				input_schema: tool.inputSchema,
			})),
			...(thinking ? { thinking } : {}),
			// Claude Code's own clear-thinking context edits are invalid once thinking is disabled.
			...(thinking?.type === "disabled" ? { context_management: { edits: [] } } : {}),
			...(isRecord(body.output_config) ? { output_config: body.output_config } : {}),
			...(maxTokens ? { max_tokens: maxTokens } : {}),
		},
	};
}

/** Reads events up to the next `result`, or undefined when Claude Code's output ends first. */
async function nextResult(events: AsyncGenerator<ClaudeCodeEvent>): Promise<ClaudeCodeEvent | undefined> {
	for (let next = await events.next(); !next.done; next = await events.next()) {
		if (next.value.type === "result") return next.value;
	}
	return undefined;
}

/** Reads events up to the next raw Messages stream event or `result`, or undefined when Claude Code's output ends first. */
async function nextAnswerEvent(events: AsyncGenerator<ClaudeCodeEvent>): Promise<ClaudeCodeEvent | undefined> {
	for (let next = await events.next(); !next.done; next = await events.next()) {
		if (next.value.type === "result" || (next.value.type === "stream_event" && isRecord(next.value.event)))
			return next.value;
	}
	return undefined;
}

/** Explains a Claude Code exit that never reached Anthropic, without passing native text through. */
function stoppedBeforeRequest(result: ClaudeCodeEvent | undefined): string {
	if (!result) return "Claude Code exited before contacting Anthropic. Run /login anthropic to check the connection.";
	const detail = typeof result.result === "string" ? result.result : "";
	if (/log ?in|authenticat|oauth|credential|api key/i.test(detail)) return NOT_SIGNED_IN;
	return `Claude Code stopped before contacting Anthropic (${String(result.subtype)}). Run /login anthropic to check the connection.`;
}

/**
 * Rebuilds Anthropic's error body for an API error Claude Code reported in its `result`, so retries and
 * context-overflow handling match the API-key route. Undefined when the result carries no HTTP status.
 */
function apiError(result: ClaudeCodeEvent): { status: number; body: string } | undefined {
	const status = result.api_error_status;
	if (result.is_error !== true || typeof status !== "number" || !Number.isInteger(status) || status < 400)
		return undefined;
	const message = status === 401 ? NOT_SIGNED_IN : typeof result.result === "string" ? result.result : "";
	const body = { type: "error", error: { type: ERROR_TYPES[status] ?? "api_error", message } };
	return { status, body: JSON.stringify(body) };
}

/** Strips the MCP prefix from a tool call in one stream event and rejects tools lunR did not offer. */
function renameToolCall(event: Record<string, unknown>, inventory: ReadonlySet<string>): Record<string, unknown> {
	const block = event.content_block;
	if (event.type !== "content_block_start" || !isRecord(block) || block.type !== "tool_use") return event;
	const name = block.name;
	const tool = typeof name === "string" && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : "";
	if (!inventory.has(tool)) throw new Error("Claude Code returned a tool outside lunR's tool list");
	return { ...event, content_block: { ...block, name: tool } };
}

const sseEvent = (type: string, data: string) => `event: ${type}\ndata: ${data}\n\n`;

/**
 * Turns Claude Code's stream-json output into the Messages SSE body lunR's Anthropic client expects.
 * Each `stream_event` line carries one raw upstream event. The stream ends at `message_stop`; a `result`
 * before then becomes an SSE error. Cleanup runs once the stream ends, fails, or is cancelled.
 * `onEnd` runs once when the stream ends, with whether a complete answer stopped for tool calls.
 */
function answerStream(
	first: ClaudeCodeEvent,
	next: () => Promise<ClaudeCodeEvent | undefined>,
	inventory: ReadonlySet<string>,
	finish: (graceful?: boolean) => Promise<void>,
	onEnd: (toolUse: boolean) => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let pending: ClaudeCodeEvent | undefined = first;
	let toolUse = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const event = pending ?? (await next());
				pending = undefined;
				if (!event || event.type === "result") {
					const error = event && apiError(event);
					const body =
						error?.body ??
						JSON.stringify({
							type: "error",
							error: { type: "api_error", message: "Claude Code stream ended before message_stop" },
						});
					controller.enqueue(encoder.encode(sseEvent("error", body)));
					controller.close();
					onEnd(false);
					await finish(!!error);
					return;
				}
				if (!isRecord(event.event) || typeof event.event.type !== "string") return;
				const data = renameToolCall(event.event, inventory);
				controller.enqueue(encoder.encode(sseEvent(event.event.type, JSON.stringify(data))));
				if (data.type === "message_delta" && isRecord(data.delta)) toolUse = data.delta.stop_reason === "tool_use";
				if (data.type === "message_stop") {
					// The answer is complete; stopping now also keeps Claude Code from any further request.
					controller.close();
					onEnd(toolUse);
					await finish();
				}
			} catch (error) {
				controller.error(error);
				onEnd(false);
				await finish();
			}
		},
		async cancel() {
			onEnd(false);
			await finish();
		},
	});
}

/** Failures before any upstream answer travel as an SSE error event, so the Messages stream reports the text unchanged. */
function localFailure(message: string): Response {
	return new Response(`event: error\ndata: ${message.replace(/\s*\n\s*/g, " ")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** One stream-json input line. Claude Code appends a replayed user turn without a generation and acknowledges it. */
interface InputLine {
	text: string;
	replay: boolean;
}

/**
 * Input lines for a request's frames: every user turn but the last is a replay. With `allReplays` the
 * last one is too, which is how a prewarmed process holds history before the next turn exists.
 */
function inputLines(frames: readonly Frame[], allReplays = false): InputLine[] {
	return frames.map((frame, index) => {
		const replay = frame.type === "user" && (allReplays || index < frames.length - 1);
		return { text: `${JSON.stringify(replay ? { ...frame, shouldQuery: false } : frame)}\n`, replay };
	});
}

/** Everything about a request that a started Claude Code process fixes, apart from its frames. */
function launchKey(connection: ExternalClaudeCodeCredential, request: ClaudeCodeRequest, upstream?: string): string {
	const { route, system, tools, extraBody, maxTokens } = request;
	return JSON.stringify([
		connection.command,
		connection.configDir,
		upstream,
		route,
		system,
		tools,
		extraBody,
		maxTokens,
	]);
}

/** A started Claude Code process with its MCP endpoint and private directory. */
interface ClaudeCodeProcess {
	child: ChildProcessWithoutNullStreams;
	events: AsyncGenerator<ClaudeCodeEvent>;
	loopback: ClaudeCodeLoopback;
	exited: Promise<void>;
	/** Rejects when the process fails to start or run; attached at spawn, before the error can fire. */
	failed: Promise<never>;
	/** Kills the process tree, closes the MCP endpoint and removes the directory. Runs once. */
	stop: () => Promise<void>;
	/** `stop` for process exit, where asynchronous cleanup never runs. */
	stopNow: () => void;
}

async function within<T>(promise: Promise<T>, message: string, ms: number, interrupted: Promise<never>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout, interrupted]);
	} finally {
		clearTimeout(timer);
	}
}

/** Writes input lines, waiting for Claude Code to acknowledge each replayed user turn. */
async function writeLines(
	claude: ClaudeCodeProcess,
	lines: readonly InputLine[],
	wait: <T>(promise: Promise<T>, message: string) => Promise<T>,
): Promise<void> {
	for (const line of lines) {
		claude.child.stdin.write(line.text);
		if (!line.replay) continue;
		const ack = await wait(nextResult(claude.events), "Claude Code history replay timed out.");
		if (!ack) throw new Error("Claude Code exited during history replay");
		if (ack.num_turns !== 0 || ack.is_error) throw new Error("Claude Code rejected the history replay");
	}
}

/** Starts Claude Code for a request. It sends nothing to Anthropic until it reads a user turn that queries. */
async function startClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
	signal?: AbortSignal,
): Promise<ClaudeCodeProcess> {
	if (!existsSync(connection.command))
		throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
	const loopback = await ClaudeCodeLoopback.open(request.tools);
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-")).catch((error: unknown) => {
		loopback.close();
		throw error;
	});
	let pid: number | undefined;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		stopping ??= (async () => {
			loopback.close();
			await stopProcessTree(pid);
			// Windows can hold the working directory briefly after the process tree ends.
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		})();
		return stopping;
	};
	try {
		await writeFile(join(directory, "system.md"), request.system, { encoding: "utf8", mode: 0o600 });
		// Settings carry the body override inside the process, avoiding per-argument size limits for large tool schemas.
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(request.extraBody) } }),
			{ encoding: "utf8", mode: 0o600 },
		);
		// The MCP URL carries a secret path, so it goes in a file rather than on the visible command line.
		await writeFile(
			join(directory, "mcp.json"),
			JSON.stringify({ mcpServers: { lunr: { type: "http", url: loopback.mcpUrl } } }),
			{ encoding: "utf8", mode: 0o600 },
		);
		const env = {
			...claudeCodeEnvironment(connection.configDir),
			...REQUEST_ENV,
			// Unset outside tests, so Claude Code sends its request to Anthropic directly.
			...(upstream ? { ANTHROPIC_BASE_URL: upstream } : {}),
			...(request.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) } : {}),
		};
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		// Claude Code tells the model its working directory in an environment note it adds to every request,
		// so it runs in lunR's own directory. Empty setting sources keep that directory's CLAUDE.md and settings out.
		const child = spawnClaudeCode(
			connection.command,
			[
				"-p",
				"--model",
				request.route,
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				// Emits each raw Messages stream event, which lunR replays as the SSE body.
				"--include-partial-messages",
				"--tools",
				"",
				"--system-prompt-file",
				join(directory, "system.md"),
				"--settings",
				join(directory, "settings.json"),
				"--setting-sources",
				"",
				"--strict-mcp-config",
				"--mcp-config",
				join(directory, "mcp.json"),
				"--disable-slash-commands",
				"--max-turns",
				"1",
				"--permission-mode",
				"dontAsk",
				"--no-session-persistence",
			],
			env,
			process.cwd(),
		);
		pid = child.pid;
		// Output already written stays readable after the process closes.
		const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const failed = new Promise<never>((_, reject) => child.once("error", reject));
		failed.catch(() => {});
		const stopNow = () => {
			loopback.close();
			stopProcessTreeSync(pid);
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* Best effort while exiting. */
			}
		};
		return { child, events: claudeCodeEvents(child.stdout), loopback, exited, failed, stop, stopNow };
	} catch (error) {
		await stop();
		throw error;
	}
}

/**
 * A Claude Code process started while a turn is answered and its tools run. It holds that session's known
 * history as replays, so the next request only writes its new frames. It never gets a user turn that queries unless
 * a matching request claims it.
 */
interface Prewarm {
	key: string;
	lines: InputLine[];
	/** The process once every replay is acknowledged. Rejects when start or replay fails. */
	ready: Promise<ClaudeCodeProcess>;
	/** Hands the process to a request: discarding no longer stops it. */
	claim: () => void;
	discard: () => void;
}

/** At most one prewarmed process per session id. */
const prewarms = new Map<string, Prewarm>();
/** Prewarmed processes not yet claimed, stopped synchronously if lunR exits first. */
const unclaimed = new Set<ClaudeCodeProcess>();
let exitHookInstalled = false;

/**
 * Starts the process for a session's next request from the request now being answered, so it is ready
 * when that answer's tool results are. It is discarded when the answer does not stop for tool calls,
 * after `idleMs` without a claim, when `signal` aborts, or when the session's next request does not match.
 */
function prewarm(
	session: string,
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
	idleMs: number,
	signal: AbortSignal | undefined,
): Prewarm | undefined {
	prewarms.get(session)?.discard();
	if (signal?.aborted) return undefined;
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => {
			for (const claude of unclaimed) claude.stopNow();
		});
	}
	let state: "waiting" | "claimed" | "discarded" = "waiting";
	const lines = inputLines(request.frames, true);
	const started = startClaudeCode(connection, request, upstream);
	const ready = started.then(async (claude) => {
		if (state === "discarded") throw new Error("Claude Code prewarm discarded");
		await writeLines(claude, lines, (promise, message) => within(promise, message, idleMs, claude.failed));
		return claude;
	});
	const timer = setTimeout(() => entry.discard(), idleMs);
	timer.unref();
	const onAbort = () => entry.discard();
	const settle = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if (prewarms.get(session) === entry) prewarms.delete(session);
	};
	const entry: Prewarm = {
		key: launchKey(connection, request, upstream),
		lines,
		ready,
		claim() {
			state = "claimed";
			settle();
			void started.then(
				(claude) => unclaimed.delete(claude),
				() => {},
			);
		},
		discard() {
			if (state !== "waiting") return;
			state = "discarded";
			settle();
			void started.then(
				(claude) => {
					unclaimed.delete(claude);
					return claude.stop();
				},
				() => {},
			);
		},
	};
	void started.then(
		(claude) => {
			if (state === "waiting") unclaimed.add(claude);
			claude.child.once("close", () => entry.discard());
		},
		() => entry.discard(),
	);
	ready.catch(() => entry.discard());
	signal?.addEventListener("abort", onAbort, { once: true });
	prewarms.set(session, entry);
	return entry;
}

/**
 * Takes the session's prewarmed process when it was started with the same launch settings and holds
 * exactly the first lines of this request. Any other prewarm for the session is discarded.
 */
async function claimPrewarm(session: string, key: string, lines: readonly InputLine[]) {
	const warm = prewarms.get(session);
	if (!warm) return undefined;
	const matches =
		warm.key === key &&
		lines.length > warm.lines.length &&
		warm.lines.every((line, index) => line.text === lines[index]?.text);
	if (!matches) {
		warm.discard();
		return undefined;
	}
	warm.claim();
	const claude = await warm.ready.catch(() => undefined);
	return claude && { claude, written: warm.lines.length };
}

async function runClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	signal: AbortSignal | undefined,
	idleMs: number,
	upstream: string | undefined,
	session: string,
): Promise<Response> {
	const lines = inputLines(request.frames);
	const warm = await claimPrewarm(session, launchKey(connection, request, upstream), lines);
	const claude = warm?.claude ?? (await startClaudeCode(connection, request, upstream, signal));
	let cleanup: Promise<void> | undefined;
	// With `graceful`, a Claude Code that is still saving its own state (for example a sign-in refreshed after
	// a 401) gets CLAUDE_CODE_EXIT_GRACE_MS to exit before the tree is killed. A user abort ends the wait.
	const finish = (graceful = false) => {
		cleanup ??= (async () => {
			claude.loopback.close();
			if (graceful && !signal?.aborted) {
				let timer: NodeJS.Timeout | undefined;
				const aborted = new Promise<void>((resolve) =>
					signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				const grace = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, CLAUDE_CODE_EXIT_GRACE_MS);
				});
				await Promise.race([claude.exited, grace, aborted]);
				clearTimeout(timer);
			}
			await claude.stop();
		})();
		return cleanup;
	};
	// An abort while lunR reads the body must still end Claude Code and close the MCP endpoint.
	signal?.addEventListener("abort", () => void finish(), { once: true });
	let upcoming: Prewarm | undefined;
	try {
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		claude.child.once("close", () => void finish());
		const cancelled = new Promise<never>((_, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("Claude Code request cancelled")), { once: true });
		});
		const interrupted = Promise.race([claude.failed, cancelled]);
		interrupted.catch(() => {});
		const wait = <T>(promise: Promise<T>, message: string) => within(promise, message, idleMs, interrupted);

		await writeLines(claude, lines.slice(warm?.written ?? 0), wait);
		claude.child.stdin.end();
		upcoming = prewarm(session, connection, request, upstream, idleMs, signal);

		const first = await wait(nextAnswerEvent(claude.events), "Claude Code request timed out.");
		if (first?.type !== "stream_event") {
			const error = first && apiError(first);
			// An API error without an HTTP status means Claude Code never got an answer, such as a refused connection.
			if (!error && first?.terminal_reason === "api_error")
				throw new Error(
					`Claude Code network error: ${typeof first.result === "string" ? first.result : "no answer"}`,
				);
			if (!error) throw new Error(stoppedBeforeRequest(first));
			upcoming?.discard();
			await finish(true);
			return new Response(error.body, { status: error.status, headers: { "content-type": "application/json" } });
		}
		const inventory = new Set(request.tools.map((tool) => tool.name));
		const next = () => wait(nextAnswerEvent(claude.events), "Claude Code request timed out.");
		const onEnd = (toolUse: boolean) => {
			if (!toolUse) upcoming?.discard();
		};
		return new Response(answerStream(first, next, inventory, finish, onEnd), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	} catch (error) {
		upcoming?.discard();
		await finish();
		throw error;
	}
}

/**
 * `fetch` for the Anthropic SDK that sends each Messages request through lunR's pinned Claude Code
 * instead of HTTPS. `session` scopes prewarmed processes to one conversation. Exported for tests, which
 * point `upstream` at a loopback fixture.
 */
export function claudeCodeFetch(
	connection: ExternalClaudeCodeCredential,
	idleMs: number,
	upstream?: string,
	session = "",
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (_input, init) => {
		const signal = init?.signal ?? undefined;
		try {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			return await runClaudeCode(connection, claudeCodeRequest(body, connection), signal, idleMs, upstream, session);
		} catch (error) {
			if (signal?.aborted) throw error;
			return localFailure(error instanceof Error ? error.message : String(error));
		}
	};
}

function validateOptions(model: Model<Api>, options: StreamOptions | SimpleStreamOptions): void {
	if (
		options.apiKey ||
		Object.keys(options.headers ?? {}).length ||
		options.onPayload ||
		options.onResponse ||
		options.env ||
		options.metadata ||
		(options.transport && options.transport !== "auto") ||
		options.maxRetries ||
		(options.maxRetryDelayMs !== undefined && options.maxRetryDelayMs !== 60_000) ||
		options.websocketConnectTimeoutMs ||
		model.baseUrl !== "https://api.anthropic.com"
	) {
		throw new Error("Claude Code subscription does not support API keys, alternate endpoints, or request mutations");
	}
	const anthropic = options as StreamOptions & {
		toolChoice?: unknown;
		client?: unknown;
		extraBody?: unknown;
		thinkingBudgetTokens?: unknown;
		stopSequences?: unknown;
		thinkingDisplay?: unknown;
		interleavedThinking?: unknown;
	};
	if (
		(anthropic.toolChoice && anthropic.toolChoice !== "auto") ||
		anthropic.client ||
		anthropic.extraBody ||
		anthropic.thinkingBudgetTokens ||
		anthropic.stopSequences ||
		anthropic.thinkingDisplay !== undefined ||
		anthropic.interleavedThinking !== undefined
	) {
		throw new Error("Claude Code subscription does not support forced tools or native request overrides");
	}
	if (options.temperature !== undefined)
		throw new Error("Claude Code subscription does not support sampling overrides");
}

/**
 * Streams one Anthropic turn for a Claude subscription. lunR builds the same Messages request it sends
 * with an API key; the injected client hands it to Claude Code, which authenticates and sends it.
 * Tool references, eager tool input, cache markers, and sampling stay off because Claude Code manages
 * those parts of its own request.
 */
export function streamClaudeCode(
	model: Model<"anthropic-messages">,
	context: Context,
	options: StreamOptions | SimpleStreamOptions,
	simple: boolean,
	/** Tests point this at a loopback fixture; requests otherwise go to api.anthropic.com. */
	upstream?: string,
): AssistantMessageEventStream {
	validateOptions(model, options);
	const connection = options.externalClaudeCode;
	if (!connection) throw new Error("Claude Code subscription setup is required. Run /login anthropic.");
	if (connection.version !== 3) throw new Error(CLAUDE_CODE_UPDATE_REQUIRED);
	const idleMs = Math.min(300_000, Math.max(1000, options.timeoutMs ?? 180_000));
	const client = new Anthropic({
		// Never sent anywhere: the fetch override replaces HTTP, and Claude Code supplies its own sign-in.
		apiKey: "claude-code-subscription",
		maxRetries: 0,
		fetch: claudeCodeFetch(connection, idleMs, upstream, options.sessionId),
	});
	const transportModel: Model<"anthropic-messages"> = {
		...model,
		compat: {
			...model.compat,
			supportsToolReferences: false,
			supportsEagerToolInputStreaming: false,
			supportsCacheControlOnTools: false,
			supportsTemperature: false,
		},
	};
	const transportOptions = {
		...options,
		externalClaudeCode: undefined,
		client,
		cacheRetention: "none" as const,
	};
	return simple
		? streamSimpleMessages(transportModel, context, transportOptions)
		: streamMessages(transportModel, context, transportOptions);
}
