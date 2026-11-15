import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_UPDATE_REQUIRED } from "../auth/anthropic-route.ts";
import type { ExternalClaudeCodeCredential } from "../auth/types.ts";
import { registerModelSwitchCleanup, registerSessionResourceCleanup } from "../session-resources.ts";
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
} from "./claude-code-process.ts";
import { ClaudeCodeSession, type SessionStep } from "./claude-code-session.ts";

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
	// Each request is a new process, so this startup work repeats per request: git status, log and user name
	// for a git note, and memory and CLAUDE.md files. lunR's history replaces all of it; on the replay route
	// it is context lunR did not ask for.
	CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
} as const;
/**
 * Extra switches for a process kept for a whole session. Claude Code runs lunR's tool calls through the
 * held MCP calls, so it must neither move a slow call to the background, time it out, nor cut a large
 * result; each would put a tool result in its history that lunR never sent. A kept process also adds
 * notes of its own between turns ("The user hasn't heard from you in a while", turn updates), which lunR
 * never shows. Its own effort level must match lunR's, or a replay records a per-turn effort change.
 */
const SESSION_ENV = {
	CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
	CLAUDE_CODE_TURN_UPDATES: "0",
	CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
	CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "86400000",
	MCP_TOOL_TIMEOUT: "86400000",
	MAX_MCP_OUTPUT_TOKENS: "100000000",
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
	/** Skips Claude Code's turn-start context (memory, reminders, file mentions) for this turn. */
	client_composed?: true;
}

/** Claude Code refuses a settings file over 2 MiB; the rest is headroom for the JSON wrapper. */
const SETTINGS_LIMIT = 2 * 1024 * 1024 - 4096;
/** Matches the TTL of the two system-prompt markers Claude Code adds, which must not come after a shorter one. */
const HISTORY_MARKER = { type: "ephemeral", ttl: "1h" } as const;

/**
 * A Messages request translated into Claude Code's inputs. Normally `extraBody.messages` carries lunR's
 * history and `frames` is the one turn Claude Code queries with. A history too large for the settings
 * file is replayed through `frames` instead.
 */
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

/** The settings that carry the request body override into Claude Code. */
function settings(extraBody: Record<string, unknown>): Record<string, unknown> {
	return { env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extraBody) } };
}

/**
 * lunR's history as the request's `messages`, with a cache marker on the newest block. Sending it through
 * the body keeps the prefix byte-identical across requests: Claude Code attaches its own turn-start context
 * (date, account email, memory) to whichever turn queries, and each request is a new Claude Code process.
 */
function historyMessages(history: readonly Frame[]): Record<string, unknown>[] {
	return history.map(({ message: { role, content } }, index) => ({
		role,
		content:
			index === history.length - 1
				? content.map((block, blockIndex) =>
						blockIndex === content.length - 1 ? { ...block, cache_control: HISTORY_MARKER } : block,
					)
				: content,
	}));
}

/**
 * The one turn Claude Code queries with when the body carries the history. Claude Code's billing header
 * fingerprints the first user text, so the turn repeats the first text of lunR's history.
 */
function queryFrame(history: readonly Frame[]): Frame {
	const first = history.find((frame) => frame.type === "user")?.message.content.find((block) => block.type === "text");
	const text = typeof first?.text === "string" && first.text ? first.text : ".";
	return { type: "user", client_composed: true, message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * Validates the request lunR's Messages implementation built and maps it onto Claude Code's inputs, with
 * the whole history as frames. The route is the one setup saved for the model, so Claude Code gets
 * exactly the variant discovery chose.
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
	const history = historyFrames(body.messages, body.model);
	const request = {
		route,
		system,
		frames: history,
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
	return request;
}

/**
 * The inputs for one Claude Code process per request: the history goes in the body when it fits the
 * settings file, and is replayed through stdin otherwise.
 */
function oneShotRequest(request: ClaudeCodeRequest): ClaudeCodeRequest {
	const extraBody = { ...request.extraBody, messages: historyMessages(request.frames) };
	return Buffer.byteLength(JSON.stringify(settings(extraBody))) <= SETTINGS_LIMIT
		? { ...request, frames: [queryFrame(request.frames)], extraBody }
		: request;
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
 */
function answerStream(
	first: ClaudeCodeEvent,
	next: () => Promise<ClaudeCodeEvent | undefined>,
	inventory: ReadonlySet<string>,
	finish: (graceful?: boolean) => Promise<void>,
	/** Sees each raw event passed on, before tool names lose their prefix. */
	observe?: (event: Record<string, unknown>) => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let pending: ClaudeCodeEvent | undefined = first;
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
					await finish(!!error);
					return;
				}
				if (!isRecord(event.event) || typeof event.event.type !== "string") return;
				const data = renameToolCall(event.event, inventory);
				observe?.(event.event);
				controller.enqueue(encoder.encode(sseEvent(event.event.type, JSON.stringify(data))));
				if (data.type === "message_stop") {
					// The answer is complete; stopping now also keeps Claude Code from any further request.
					controller.close();
					await finish();
				}
			} catch (error) {
				controller.error(error);
				await finish();
			}
		},
		async cancel() {
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

/** Passes `events` through, calling `onFirst` when the first one arrives. */
async function* notifyFirst(
	events: AsyncGenerator<ClaudeCodeEvent>,
	onFirst: () => void,
): AsyncGenerator<ClaudeCodeEvent> {
	let first = true;
	for await (const event of events) {
		if (first) onFirst();
		first = false;
		yield event;
	}
}

/** Arguments every lunR Claude Code process shares; its files live in `directory`. */
function claudeCodeArgs(route: string, directory: string): string[] {
	return [
		"-p",
		"--model",
		route,
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
		"--no-session-persistence",
	];
}

/** Writes the files `claudeCodeArgs` names. Settings carry the body override and any hooks. */
async function writeClaudeCodeFiles(
	directory: string,
	system: string,
	settings: Record<string, unknown>,
	mcpUrl: string,
): Promise<void> {
	const file = { encoding: "utf8", mode: 0o600 } as const;
	await writeFile(join(directory, "system.md"), system, file);
	// Settings carry the body override inside the process, avoiding per-argument size limits for large tool schemas.
	await writeFile(join(directory, "settings.json"), JSON.stringify(settings), file);
	// The MCP URL carries a secret path, so it goes in a file rather than on the visible command line.
	await writeFile(
		join(directory, "mcp.json"),
		JSON.stringify({ mcpServers: { lunr: { type: "http", url: mcpUrl } } }),
		file,
	);
}

async function runClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	signal: AbortSignal | undefined,
	idleMs: number,
	upstream: string | undefined,
	/** Called once Claude Code prints its first line, when its startup work is done. */
	onStarted?: () => void,
): Promise<Response> {
	if (!existsSync(connection.command))
		throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
	const loopback = await ClaudeCodeLoopback.open(request.tools);
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-")).catch((error: unknown) => {
		loopback.close();
		throw error;
	});
	let pid: number | undefined;
	let cleanup: Promise<void> | undefined;
	let exited: Promise<void> | undefined;
	// With `graceful`, a Claude Code that is still saving its own state (for example a sign-in refreshed after
	// a 401) gets CLAUDE_CODE_EXIT_GRACE_MS to exit before the tree is killed. A user abort ends the wait.
	const finish = (graceful = false) => {
		cleanup ??= (async () => {
			loopback.close();
			if (graceful && exited && !signal?.aborted) {
				let timer: NodeJS.Timeout | undefined;
				const aborted = new Promise<void>((resolve) =>
					signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				const grace = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, CLAUDE_CODE_EXIT_GRACE_MS);
				});
				await Promise.race([exited, grace, aborted]);
				clearTimeout(timer);
			}
			await stopProcessTree(pid);
			// Windows can hold the working directory briefly after the process tree ends.
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		})();
		return cleanup;
	};
	// An abort while lunR reads the body must still end Claude Code and close the MCP endpoint.
	signal?.addEventListener("abort", () => void finish(), { once: true });
	try {
		await writeClaudeCodeFiles(directory, request.system, settings(request.extraBody), loopback.mcpUrl);
		const env = {
			...claudeCodeEnvironment(connection.configDir),
			...REQUEST_ENV,
			// Unset outside tests, so Claude Code sends its request to Anthropic directly.
			...(upstream ? { ANTHROPIC_BASE_URL: upstream } : {}),
			...(request.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) } : {}),
		};
		// The replay route keeps Claude Code's environment note, which names the working directory, so it runs in
		// lunR's own directory there. lunR's history replaces that note otherwise, and an empty directory skips
		// Claude Code's per-start git checks and file listing of the project. Empty setting sources keep the
		// directory's CLAUDE.md and settings out.
		const historyInBody = "messages" in request.extraBody;
		const cwd = historyInBody ? join(directory, "cwd") : process.cwd();
		if (historyInBody) await mkdir(cwd);
		// Cleanup that already ran during the writes above had no process to stop, so never start one.
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		const child = spawnClaudeCode(
			connection.command,
			[...claudeCodeArgs(request.route, directory), "--max-turns", "1", "--permission-mode", "dontAsk"],
			env,
			cwd,
		);
		pid = child.pid;
		// Output already written stays readable after the process closes, so cleanup is safe here too.
		exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
		child.once("close", () => void finish());
		const interrupted = new Promise<never>((_, reject) => {
			child.once("error", reject);
			if (signal?.aborted) reject(new Error("Claude Code request cancelled"));
			signal?.addEventListener("abort", () => reject(new Error("Claude Code request cancelled")), { once: true });
		});
		interrupted.catch(() => {});
		const within = async <T>(promise: Promise<T>, message: string): Promise<T> => {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), idleMs);
			});
			try {
				return await Promise.race([promise, timeout, interrupted]);
			} finally {
				clearTimeout(timer);
			}
		};

		const events = onStarted
			? notifyFirst(claudeCodeEvents(child.stdout), onStarted)
			: claudeCodeEvents(child.stdout);
		for (const [index, frame] of request.frames.entries()) {
			// Earlier user turns are appended without a generation; Claude Code acknowledges each with a zero-turn result.
			const replay = frame.type === "user" && index < request.frames.length - 1;
			child.stdin.write(`${JSON.stringify(replay ? { ...frame, shouldQuery: false } : frame)}\n`);
			if (!replay) continue;
			const ack = await within(nextResult(events), "Claude Code history replay timed out.");
			if (!ack) throw new Error("Claude Code exited during history replay");
			if (ack.num_turns !== 0 || ack.is_error) throw new Error("Claude Code rejected the history replay");
		}
		child.stdin.end();

		const first = await within(nextAnswerEvent(events), "Claude Code request timed out.");
		if (first?.type !== "stream_event") {
			const error = first && apiError(first);
			// An API error without an HTTP status means Claude Code never got an answer, such as a refused connection.
			if (!error && first?.terminal_reason === "api_error")
				throw new Error(
					`Claude Code network error: ${typeof first.result === "string" ? first.result : "no answer"}`,
				);
			if (!error) throw new Error(stoppedBeforeRequest(first));
			await finish(true);
			return new Response(error.body, { status: error.status, headers: { "content-type": "application/json" } });
		}
		const inventory = new Set(request.tools.map((tool) => tool.name));
		const next = () => within(nextAnswerEvent(events), "Claude Code request timed out.");
		return new Response(answerStream(first, next, inventory, finish), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	} catch (error) {
		await finish();
		throw error;
	}
}

/** Live processes by lunR session id. A pending entry is a process that is still starting. */
const sessions = new Map<string, Promise<ClaudeCodeSession | undefined>>();
/** Every live process that has not exited, for the synchronous kill when lunR exits. */
const running = new Set<ClaudeCodeSession>();

/** Stops the live process of one lunR session, or of all of them. */
function stopSessions(sessionId?: string): void {
	for (const [id, entry] of sessions) {
		if (sessionId !== undefined && id !== sessionId) continue;
		sessions.delete(id);
		void entry.then((session) => session?.close());
	}
}
registerSessionResourceCleanup(stopSessions);
registerModelSwitchCleanup(stopSessions);
// SIGINT, SIGTERM and SIGHUP end lunR through process.exit. A kill -9 closes Claude Code's stdin, which ends
// an idle process, and fails any held tool call, which the session's failure hook turns into a kill.
process.once("exit", () => {
	for (const session of running) session.kill();
});

const MEDIA: ReadonlySet<unknown> = new Set(["image", "document"]);

/** Whether any turn carries an image or document, directly or inside a tool result. */
function hasMedia(frames: readonly Frame[]): boolean {
	return frames.some((frame) =>
		frame.message.content.some(
			(block) =>
				MEDIA.has(block.type) ||
				(Array.isArray(block.content) && block.content.some((item) => isRecord(item) && MEDIA.has(item.type))),
		),
	);
}

/** Everything a live process fixes when it starts. A request with another key needs another process. */
function sessionKey(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
): string {
	const { route, system, extraBody, maxTokens } = request;
	return JSON.stringify([
		connection.command,
		connection.configDir,
		route,
		system,
		extraBody,
		maxTokens,
		process.cwd(),
		upstream,
	]);
}

/**
 * Starts the Claude Code process for one lunR session. lunR's history goes in through stdin frames, not
 * the body, so later requests can add to it. It runs in lunR's directory because Claude Code's environment
 * note names that directory.
 */
async function startSession(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	key: string,
	upstream: string | undefined,
): Promise<ClaudeCodeSession> {
	if (!existsSync(connection.command))
		throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
	let session: ClaudeCodeSession | undefined;
	const loopback = await ClaudeCodeLoopback.open(request.tools, (id) =>
		session ? session.toolCall(id) : Promise.reject(new Error("Claude Code session is not ready")),
	);
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-")).catch((error: unknown) => {
		loopback.close();
		throw error;
	});
	const cleanup = async () => {
		loopback.close();
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	};
	try {
		// A failed tool call means lunR's MCP endpoint went away. If lunR itself is gone, Claude Code would
		// answer the failure with another model request; the hook kills it first. Hooks run in their own
		// process group with Claude Code as parent, the leader of its group.
		const hook = { type: "command", command: `kill -0 ${process.pid} 2>/dev/null || kill -KILL -$PPID` };
		await writeClaudeCodeFiles(
			directory,
			request.system,
			{
				...settings(request.extraBody),
				hooks: { PostToolUseFailure: [{ matcher: `${TOOL_PREFIX}.*`, hooks: [hook] }] },
			},
			loopback.mcpUrl,
		);
		const output = request.extraBody.output_config;
		const effort = isRecord(output) && typeof output.effort === "string" ? output.effort : undefined;
		const env = {
			...claudeCodeEnvironment(connection.configDir),
			...REQUEST_ENV,
			...SESSION_ENV,
			...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}),
			// Unset outside tests, so Claude Code sends its request to Anthropic directly.
			...(upstream ? { ANTHROPIC_BASE_URL: upstream } : {}),
			...(request.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) } : {}),
		};
		const child = spawnClaudeCode(
			connection.command,
			[...claudeCodeArgs(request.route, directory), "--permission-mode", "dontAsk", "--allowedTools", "mcp__lunr"],
			env,
			process.cwd(),
		);
		const started = new ClaudeCodeSession(key, child, cleanup);
		session = started;
		running.add(started);
		child.once("close", () => running.delete(started));
		child.once("error", () => void started.close());
		return started;
	} catch (error) {
		await cleanup();
		throw error;
	}
}

/** Reads to the next answer event or `result`, failing when a tool result Claude Code recorded is not lunR's. */
async function nextSessionEvent(session: ClaudeCodeSession, step: SessionStep): Promise<ClaudeCodeEvent | undefined> {
	for (let next = await session.events.next(); !next.done; next = await session.events.next()) {
		const event = next.value;
		if (!session.verify(event, step)) {
			void session.close();
			throw new Error("Claude Code recorded a tool result that differs from lunR's; the request was stopped.");
		}
		if (event.type === "result" || (event.type === "stream_event" && isRecord(event.event))) return event;
	}
	return undefined;
}

/** Runs one request on a live process; `step` says what the process still needs from `request`. */
async function runSessionStep(
	session: ClaudeCodeSession,
	step: SessionStep,
	request: ClaudeCodeRequest,
	signal: AbortSignal | undefined,
	idleMs: number,
): Promise<Response> {
	session.begin(step, request.frames);
	let complete = false;
	// A user abort ends the process: Claude Code's copy would hold a turn lunR does not keep.
	signal?.addEventListener("abort", () => void session.close(), { once: true });
	const within = async <T>(promise: Promise<T>, message: string): Promise<T> => {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), idleMs);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		if (step.kind === "replay") {
			for (const [index, frame] of step.frames.entries()) {
				const user = frame.type === "user";
				const replay = user && index < step.frames.length - 1;
				// Every user turn is client_composed so Claude Code adds no turn-start context to it.
				session.write({
					...frame,
					...(user ? { client_composed: true } : {}),
					...(replay ? { shouldQuery: false } : {}),
				});
				if (!replay) continue;
				const ack = await within(nextResult(session.events), "Claude Code history replay timed out.");
				if (!ack || ack.num_turns !== 0 || ack.is_error) throw new Error("Claude Code rejected the history replay");
			}
		} else if (step.kind === "query") {
			// The finished turn's own result line is still unread.
			if (!(await within(nextResult(session.events), "Claude Code request timed out.")))
				throw new Error("Claude Code exited between requests");
			session.write({ ...step.frame, client_composed: true });
		}
		const first = await within(nextSessionEvent(session, step), "Claude Code request timed out.");
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		if (first?.type !== "stream_event") {
			session.finish(false);
			const error = first && apiError(first);
			if (!error && first?.terminal_reason === "api_error")
				throw new Error(
					`Claude Code network error: ${typeof first.result === "string" ? first.result : "no answer"}`,
				);
			if (!error) throw new Error(stoppedBeforeRequest(first));
			return new Response(error.body, { status: error.status, headers: { "content-type": "application/json" } });
		}
		const inventory = new Set(request.tools.map((tool) => tool.name));
		const next = () => within(nextSessionEvent(session, step), "Claude Code request timed out.");
		const observe = (event: Record<string, unknown>) => {
			session.observe(event);
			if (event.type === "message_stop") complete = true;
		};
		const finish = async () => session.finish(complete && !signal?.aborted);
		return new Response(answerStream(first, next, inventory, finish, observe), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	} catch (error) {
		session.finish(false);
		throw error;
	}
}

/**
 * Sends a request of one lunR session to that session's live Claude Code process when the request
 * continues exactly what the process holds, and restarts the process otherwise. The first request of a
 * session runs on a process of its own, as without a session, and starts the live process for the next one.
 * A request that arrives while the live process is busy runs on a process of its own and leaves it alone.
 */
async function sessionFetch(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	sessionId: string,
	signal: AbortSignal | undefined,
	idleMs: number,
	upstream: string | undefined,
): Promise<Response> {
	// Claude Code may resize media it reads from stdin, which would leave its copy different from lunR's.
	if (hasMedia(request.frames)) {
		stopSessions(sessionId);
		return runClaudeCode(connection, oneShotRequest(request), signal, idleMs, upstream);
	}
	const key = sessionKey(connection, request, upstream);
	const current = await sessions.get(sessionId);
	if (current?.busy) return runClaudeCode(connection, oneShotRequest(request), signal, idleMs, upstream);
	let session = current;
	let step = session?.plan(key, request.frames);
	if (!session || !step) {
		void current?.close();
		sessions.delete(sessionId);
		if (request.frames.length === 1) {
			// Claude Code starts faster in the empty directory a one-shot process uses. The live process
			// starts once that one is past its own startup, so the two never compete for the CPU, and is
			// ready by the next request.
			const prewarm = () => {
				if (!sessions.has(sessionId))
					sessions.set(
						sessionId,
						startSession(connection, request, key, upstream).catch(() => undefined),
					);
			};
			return runClaudeCode(connection, oneShotRequest(request), signal, idleMs, upstream, prewarm);
		}
		session = await startSession(connection, request, key, upstream);
		sessions.set(sessionId, Promise.resolve(session));
		step = session.plan(key, request.frames);
		if (!step) throw new Error("Claude Code session could not start");
	}
	return runSessionStep(session, step, request, signal, idleMs);
}

/**
 * `fetch` for the Anthropic SDK that sends each Messages request through lunR's pinned Claude Code
 * instead of HTTPS. With a session id (POSIX only) requests of that session share one live process.
 * Exported for tests, which point `upstream` at a loopback fixture.
 */
export function claudeCodeFetch(
	connection: ExternalClaudeCodeCredential,
	idleMs: number,
	upstream?: string,
	sessionId?: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (_input, init) => {
		const signal = init?.signal ?? undefined;
		try {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const request = claudeCodeRequest(body, connection);
			if (sessionId && process.platform !== "win32")
				return await sessionFetch(connection, request, sessionId, signal, idleMs, upstream);
			return await runClaudeCode(connection, oneShotRequest(request), signal, idleMs, upstream);
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
 * Tool references, eager tool input, and sampling stay off because Claude Code manages those parts of
 * its own request. lunR adds no cache markers; the bridge places the history marker itself.
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
