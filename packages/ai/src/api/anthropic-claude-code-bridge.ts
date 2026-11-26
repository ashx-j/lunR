import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_HISTORY_REPLAYED, CLAUDE_CODE_UPDATE_REQUIRED } from "../auth/anthropic-route.ts";
import type { ExternalClaudeCodeCredential } from "../auth/types.ts";
import { registerConversationCleanup, registerSessionResourceCleanup } from "../session-resources.ts";
import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { removeOldClaudeCodeVersions } from "../utils/claude-code-release.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { type AssistantMessageEventStream, createAssistantMessageEventStream } from "../utils/event-stream.ts";
import { stream as streamMessages, streamSimple as streamSimpleMessages } from "./anthropic-messages.ts";
import { ClaudeCodeLoopback, type ClaudeCodeTool } from "./claude-code-loopback.ts";
import {
	type ClaudeCodeEvent,
	claudeCodeEnvironment,
	claudeCodeEvents,
	spawnClaudeCode,
	stopProcessTree,
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
const CLAUDE_MODEL_ID = /^claude-[a-z0-9.-]+(\[1m\])?$/;
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
	/** Whether the saved login lists the model. */
	listed: boolean;
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

/**
 * Renames a tool_result's tool_reference entries, or drops one when `rename` returns undefined. The API
 * rejects a reference to a tool the request does not declare as deferred.
 */
function mapToolReferences(block: Block, rename: (name: string) => string | undefined): Block {
	if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
	const content = block.content.flatMap((entry: unknown) => {
		if (!isRecord(entry) || entry.type !== "tool_reference" || typeof entry.tool_name !== "string") return [entry];
		const name = rename(entry.tool_name);
		return name ? [{ ...entry, tool_name: name }] : [];
	});
	if (content.length) return { ...block, content };
	// The tool's output already follows as a sibling text block, and tool_result content is optional.
	const { content: _dropped, ...rest } = block;
	return rest;
}

/** Claude Code knows lunR's tools by their MCP names. A tool the bridge left out for its name loses its reference. */
const prefixedToolName = (name: string) => (TOOL_NAME.test(name) ? `${TOOL_PREFIX}${name}` : undefined);

function contentBlocks(content: unknown, allowed: ReadonlySet<unknown>): Block[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) throw new Error("Invalid Claude Code message content");
	return content.map((block) => {
		if (!isRecord(block) || !allowed.has(block.type))
			throw new Error(`Claude Code subscription does not support ${isRecord(block) ? block.type : "this"} content`);
		if (block.type === "tool_use") return { ...block, name: `${TOOL_PREFIX}${block.name}` };
		return mapToolReferences(block, prefixedToolName);
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

/** The settings file that carries the request body override into Claude Code. */
function settingsJson(extraBody: Record<string, unknown>): string {
	return JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extraBody) } });
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
 * Validates the request lunR's Messages implementation built and maps it onto Claude Code's inputs. The
 * route is the one setup saved for the model, so Claude Code gets exactly the variant discovery chose. The
 * history goes in the body when the settings JSON fits `limit` (the settings file's for a cold process, the
 * control request's for a spare) and is replayed through stdin otherwise.
 */
function claudeCodeRequest(
	body: unknown,
	connection: ExternalClaudeCodeCredential,
	limit = SETTINGS_LIMIT,
): ClaudeCodeRequest {
	if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages))
		throw new Error("Invalid Claude Code request");
	const unsupported = Object.keys(body).filter((key) => !SUPPORTED_PARAMS.has(key));
	if (unsupported.length) throw new Error(`Claude Code subscription does not support ${unsupported.join(", ")}`);
	if (body.tool_choice !== undefined && !(isRecord(body.tool_choice) && body.tool_choice.type === "auto"))
		throw new Error("Claude Code subscription does not support forced tool choice");
	// A saved route keeps the variant setup chose. A Claude id the saved login does not list, such as a model
	// newer than the login, goes to Claude Code as is; lunR only builds requests for ids its catalog or
	// models.json knows, and Anthropic decides whether the plan includes it.
	const saved = connection.models?.find((model) => model.id === body.model);
	const route = saved?.route ?? body.model;
	if (!CLAUDE_MODEL_ID.test(route))
		throw new Error(`Claude Code ${body.model} is not available through this subscription connection`);

	const system =
		typeof body.system === "string"
			? body.system
			: Array.isArray(body.system)
				? body.system
						.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
						.join("\n\n")
				: "";

	// Claude Code's MCP names cap the length; one long or unusual tool name is left out rather than failing the turn.
	const listed = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
		isRecord(tool) && typeof tool.name === "string" && TOOL_NAME.test(tool.name) && isRecord(tool.input_schema)
			? [
					{
						tool: {
							name: tool.name,
							description: typeof tool.description === "string" ? tool.description : "",
							inputSchema: tool.input_schema,
						} satisfies ClaudeCodeTool,
						deferLoading: tool.defer_loading === true,
					},
				]
			: [],
	);

	const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
	const thinking = isRecord(body.thinking) ? body.thinking : undefined;
	const history = historyFrames(body.messages, body.model);
	const request = {
		route,
		listed: !!saved,
		system,
		frames: history,
		tools: listed.map(({ tool }) => tool),
		maxTokens,
		extraBody: {
			tools: listed.map(({ tool, deferLoading }) => ({
				name: `${TOOL_PREFIX}${tool.name}`,
				description: tool.description,
				input_schema: tool.inputSchema,
				...(deferLoading ? { defer_loading: true } : {}),
			})),
			...(thinking ? { thinking } : {}),
			// Claude Code's own clear-thinking context edits are invalid once thinking is disabled.
			...(thinking?.type === "disabled" ? { context_management: { edits: [] } } : {}),
			...(isRecord(body.output_config) ? { output_config: body.output_config } : {}),
			...(maxTokens ? { max_tokens: maxTokens } : {}),
		},
	};
	const extraBody = { ...request.extraBody, messages: historyMessages(history) };
	if (Buffer.byteLength(settingsJson(extraBody)) <= limit)
		return { ...request, frames: [queryFrame(history)], extraBody };
	// Claude Code strips tool_reference blocks from a replayed transcript, which would leave loaded tools
	// unloaded. The replay drops the references and sends the deferred tools the history loaded or called
	// as normal tools. Deferred tools it never used stay out, so the model cannot call them unloaded.
	const used = new Set<unknown>();
	const frames = history.map((frame) => ({
		...frame,
		message: {
			...frame.message,
			content: frame.message.content.map((block) => {
				if (block.type === "tool_use") used.add(block.name);
				return mapToolReferences(block, (name) => {
					used.add(name);
					return undefined;
				});
			}),
		},
	}));
	return {
		...request,
		frames,
		extraBody: {
			...request.extraBody,
			tools: request.extraBody.tools.flatMap(({ defer_loading, ...tool }) =>
				!defer_loading || used.has(tool.name) ? [tool] : [],
			),
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

/**
 * Strips the MCP prefix from a tool call in one stream event and rejects tools lunR did not offer. A bare
 * lunR name passes too: the model calls an unloaded tool by the name `load_tools`' catalog shows, and the
 * agent loop answers that call with a load hint.
 */
function renameToolCall(event: Record<string, unknown>, inventory: ReadonlySet<string>): Record<string, unknown> {
	const block = event.content_block;
	if (event.type !== "content_block_start" || !isRecord(block) || block.type !== "tool_use") return event;
	const name = typeof block.name === "string" ? block.name : "";
	const tool = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
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
	answered: () => void,
	/** Told when the answer ends, and whether it stopped for tool use (another request follows). */
	nextRequest?: NextRequestHooks,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let pending: ClaudeCodeEvent | undefined = first;
	let stopReason: unknown;
	let ended = false;
	const end = (toolUse: boolean) => {
		if (!ended) nextRequest?.end(toolUse);
		ended = true;
	};
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
					end(false);
					await finish(!!error);
					return;
				}
				if (!isRecord(event.event) || typeof event.event.type !== "string") return;
				const data = renameToolCall(event.event, inventory);
				if (data.type === "message_delta" && isRecord(data.delta)) stopReason = data.delta.stop_reason;
				controller.enqueue(encoder.encode(sseEvent(event.event.type, JSON.stringify(data))));
				if (data.type === "message_stop") {
					// The answer is complete; stopping now also keeps Claude Code from any further request.
					controller.close();
					end(stopReason === "tool_use");
					await finish();
					answered();
				}
			} catch (error) {
				controller.error(error);
				end(false);
				await finish();
			}
		},
		async cancel() {
			end(false);
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

/**
 * Process directories not yet removed (they hold lunR's system prompt and the MCP URL). An exit mid-request
 * or with a spare waiting skips `finish`, so the exit hook kills waiting spares and removes the directories.
 */
const liveDirectories = new Set<string>();
let exitHookArmed = false;
function removeOnExit(directory: string): () => void {
	if (!exitHookArmed) {
		exitHookArmed = true;
		process.on("exit", () => {
			killSpares();
			for (const path of liveDirectories) rmSync(path, { recursive: true, force: true });
		});
	}
	liveDirectories.add(directory);
	return () => liveDirectories.delete(directory);
}

let oldVersionsRemoved = false;

/**
 * After the first answer this process gets from the saved Claude Code, removes other versions left by a pin
 * bump. It runs once per process and in the background, so no request waits for it.
 */
function removeOldVersionsOnce(command: string): void {
	if (oldVersionsRemoved) return;
	oldVersionsRemoved = true;
	void removeOldClaudeCodeVersions(command).catch(() => {});
}

/**
 * The connection whose binary exists. When the in-memory one's binary is gone, another lunR on the profile
 * logged in with a newer pin and removed the old version, so this reads the saved login once and uses the
 * version it names.
 */
async function currentConnection(connection: ExternalClaudeCodeCredential): Promise<ExternalClaudeCodeCredential> {
	if (existsSync(connection.command)) return connection;
	const versions = dirname(dirname(connection.command));
	if (basename(versions) === "claude-code") {
		let saved: unknown;
		try {
			saved = JSON.parse(await readFile(join(dirname(versions), "auth.json"), "utf8"));
		} catch {
			/* Falls through to the missing-binary error. */
		}
		const anthropic = isRecord(saved) ? saved.anthropic : undefined;
		if (isSavedConnection(anthropic) && existsSync(anthropic.command)) return anthropic;
	}
	throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
}

function isSavedConnection(value: unknown): value is ExternalClaudeCodeCredential {
	return (
		isRecord(value) &&
		value.type === "external_claude_code" &&
		value.version === 3 &&
		value.manager === "claude-code" &&
		typeof value.command === "string"
	);
}

/** Hooks that start a session's spare once a request has left, and drop it when no request follows. */
interface NextRequestHooks {
	start(): void;
	end(toolUse: boolean): void;
}

/** A started Claude Code process with its MCP endpoint and its private directory. */
interface ClaudeCodeProcess {
	child: ChildProcessWithoutNullStreams;
	loopback: ClaudeCodeLoopback;
	directory: string;
	/** Drops the directory from the exit hook's list once it is removed. */
	forget: () => void;
	spawnedAt: number;
}

/**
 * Writes a process's files and starts Claude Code. `settings` is the `--settings` JSON: the body for a cold
 * request, none for a spare. `inBody` says the history travels in the body, which runs Claude Code in an
 * empty directory.
 */
async function startClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
	settings: string,
	inBody: boolean,
): Promise<ClaudeCodeProcess> {
	if (!existsSync(connection.command))
		throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
	const loopback = await ClaudeCodeLoopback.open(request.tools);
	// The owner's pid in the name lets a later lunR remove what a killed one left behind.
	const directory = await mkdtemp(join(tmpdir(), `lunr-claude-code-${process.pid}-`)).catch((error: unknown) => {
		loopback.close();
		throw error;
	});
	const forget = removeOnExit(directory);
	try {
		const file = { encoding: "utf8", mode: 0o600 } as const;
		await writeFile(join(directory, "system.md"), request.system, file);
		// Settings carry the body override inside the process, avoiding per-argument size limits for large tool schemas.
		await writeFile(join(directory, "settings.json"), settings, file);
		// The MCP URL carries a secret path, so it goes in a file rather than on the visible command line.
		await writeFile(
			join(directory, "mcp.json"),
			JSON.stringify({ mcpServers: { lunr: { type: "http", url: loopback.mcpUrl } } }),
			file,
		);
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
		const cwd = inBody ? join(directory, "cwd") : process.cwd();
		if (inBody) await mkdir(cwd);
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
			cwd,
		);
		// A spawn failure (a binary removed meanwhile) arrives as an error event; whoever uses the process sees it
		// through its own listener or its closed output, so it must not crash lunR here.
		child.on("error", () => {});
		return { child, loopback, directory, forget, spawnedAt: Date.now() };
	} catch (error) {
		loopback.close();
		await rm(directory, { recursive: true, force: true }).catch(() => {});
		forget();
		throw error;
	}
}

/** Stops a process and releases its endpoint and files. */
async function discardProcess({ child, loopback, directory, forget }: ClaudeCodeProcess): Promise<void> {
	loopback.close();
	await stopProcessTree(child.pid);
	// Windows can hold the working directory briefly after the process tree ends.
	await rm(directory, { recursive: true, force: true }).catch(() => {});
	forget();
}

/** Kills waiting spares at exit, before `removeOnExit` removes their directories. */
function killSpares(): void {
	for (const { process: spare } of spares.values()) {
		try {
			if (spare.child.pid) process.kill(-spare.child.pid, "SIGKILL");
		} catch {
			/* Already exited. */
		}
	}
}

/**
 * Why a spare could not take its request: `refused`, Claude Code answered the control request with an error
 * (a binary without `apply_flag_settings`); `late`, no answer within the bound (a busy machine); `lost`, the
 * spare ended before its request left. The request then runs cold.
 */
class SpareFailed extends Error {
	readonly reason: "refused" | "late" | "lost";
	constructor(reason: SpareFailed["reason"]) {
		super(`Claude Code spare ${reason}`);
		this.reason = reason;
	}
}

/**
 * How long a spare may take to confirm its body. 2.1.310 answered in 12 to 36 ms for a small body and about
 * 35 ms per MiB above that (673 ms at 20 MiB). A spare still starting answers once it has started, sooner than
 * a cold process could, so the bound also runs to 2 s after the spare's start.
 */
function spareConfirmMs(body: string, spawnedAt: number): number {
	const forBody = 500 + 50 * Math.ceil(Buffer.byteLength(body) / (1024 * 1024));
	return Math.max(forBody, spawnedAt + 2000 - Date.now());
}

/**
 * Runs one request on a Claude Code process: a new one, or `spare`, started earlier without a body, which
 * gets the request body through the `apply_flag_settings` control request. The query frame goes out only
 * after Claude Code confirmed that body. A spare that does not confirm, or ends before its request leaves,
 * is stopped and SpareFailed thrown, so the caller runs the request cold; an abort is rethrown as is.
 */
async function runClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	signal: AbortSignal | undefined,
	idleMs: number,
	upstream: string | undefined,
	{ spare, nextRequest }: { spare?: ClaudeCodeProcess; nextRequest?: NextRequestHooks } = {},
): Promise<Response> {
	const started =
		spare ??
		(await startClaudeCode(
			connection,
			request,
			upstream,
			settingsJson(request.extraBody),
			"messages" in request.extraBody,
		));
	const { child } = started;
	let cleanup: Promise<void> | undefined;
	// Output already written stays readable after the process closes, so cleanup is safe here too.
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	// With `graceful`, a Claude Code that is still saving its own state (for example a sign-in refreshed after
	// a 401) gets CLAUDE_CODE_EXIT_GRACE_MS to exit before the tree is killed. A user abort ends the wait.
	const finish = (graceful = false) => {
		cleanup ??= (async () => {
			started.loopback.close();
			if (graceful && !signal?.aborted) {
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
			await discardProcess(started);
		})();
		return cleanup;
	};
	// An abort while lunR reads the body must still end Claude Code and close the MCP endpoint.
	signal?.addEventListener("abort", () => void finish(), { once: true });
	child.once("close", () => void finish());
	try {
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
		const interrupted = new Promise<never>((_, reject) => {
			child.once("error", reject);
			signal?.addEventListener("abort", () => reject(new Error("Claude Code request cancelled")), { once: true });
		});
		interrupted.catch(() => {});
		const within = async <T>(promise: Promise<T>, message: string, ms = idleMs): Promise<T> => {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			});
			try {
				return await Promise.race([promise, timeout, interrupted]);
			} finally {
				clearTimeout(timer);
			}
		};

		// The next request's spare starts once this request has left, so the two never compete for the CPU. A spare
		// finished its own start long ago, so the next one starts when this request is reported sent and has the whole
		// answer time to start; a cold process has only just started, so its next spare waits for the first byte.
		let sent = false;
		const events = onRequestSent(claudeCodeEvents(child.stdout), (answer) => {
			sent = true;
			if (answer || spare) nextRequest?.start();
		});
		if (spare) {
			const body = JSON.stringify(request.extraBody);
			const id = `lunr-body-${child.pid}`;
			const apply = { subtype: "apply_flag_settings", settings: { env: { CLAUDE_CODE_EXTRA_BODY: body } } };
			child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: apply })}\n`);
			const late = Symbol("late");
			const reply = await within(
				nextControlResponse(events, id),
				"late",
				spareConfirmMs(body, spare.spawnedAt),
			).catch((error: unknown) => {
				if (signal?.aborted) throw error;
				return error instanceof Error && error.message === "late" ? late : undefined;
			});
			if (reply === late) throw new SpareFailed("late");
			if (!reply) throw new SpareFailed("lost");
			if (!isRecord(reply.response) || reply.response.subtype !== "success") throw new SpareFailed("refused");
		}
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
		// A spare that ended before its request left (killed after confirming) sent nothing; the caller reruns it cold.
		if (spare && !first && !sent && !signal?.aborted) throw new SpareFailed("lost");
		if (first?.type !== "stream_event") {
			const error = first && apiError(first);
			// No request follows an answer that failed for good, so the next request's spare is not needed.
			if (!error || !isRetryableStatus(error.status)) nextRequest?.end(false);
			// An API error without an HTTP status means Claude Code never got an answer, such as a refused connection.
			if (!error && first?.terminal_reason === "api_error")
				throw new Error(
					`Claude Code network error: ${typeof first.result === "string" ? first.result : "no answer"}`,
				);
			if (!error) throw new Error(stoppedBeforeRequest(first));
			await finish(true);
			// Claude Code's own 404 text points at its --model flag, which lunR users do not have. Its result
			// carries Anthropic's message but not the error type, so a 403 counts as a model refusal only when
			// the message names the model; any other 403 (a disabled organization, a policy block) keeps it.
			const refusedModel =
				error.status === 404 ||
				(error.status === 403 && typeof first.result === "string" && first.result.includes(request.route));
			if (!request.listed && refusedModel)
				return localFailure(
					`Claude ${request.route} is not available on this subscription, or the saved login predates it. Run /login anthropic to refresh the models it offers.`,
				);
			return new Response(error.body, { status: error.status, headers: { "content-type": "application/json" } });
		}
		const inventory = new Set(request.tools.map((tool) => tool.name));
		const next = () => within(nextAnswerEvent(events), "Claude Code request timed out.");
		return new Response(
			answerStream(first, next, inventory, finish, () => removeOldVersionsOnce(connection.command), nextRequest),
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
	} catch (error) {
		await finish();
		throw error;
	}
}

/** Statuses lunR retries, after which the next request's spare is still wanted. */
function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Passes `events` through, calling `onSent(false)` when Claude Code reports its request sent and
 * `onSent(true)` when the answer's first event arrives.
 */
async function* onRequestSent(
	events: AsyncGenerator<ClaudeCodeEvent>,
	onSent: (answer: boolean) => void,
): AsyncGenerator<ClaudeCodeEvent> {
	let requested = false;
	let answered = false;
	for await (const event of events) {
		if (!requested && event.type === "system" && event.subtype === "status" && event.status === "requesting") {
			requested = true;
			onSent(false);
		}
		if (!answered && event.type === "stream_event") {
			answered = true;
			onSent(true);
		}
		yield event;
	}
}

/** Reads events up to the control response with `id`, or undefined when Claude Code's output ends first. */
async function nextControlResponse(
	events: AsyncGenerator<ClaudeCodeEvent>,
	id: string,
): Promise<ClaudeCodeEvent | undefined> {
	for (let next = await events.next(); !next.done; next = await events.next()) {
		const { type, response } = next.value;
		if (type === "control_response" && isRecord(response) && response.request_id === id) return next.value;
	}
	return undefined;
}

/**
 * Spares: Claude Code processes started before their request is ready, so a request skips Claude Code's
 * startup (about 0.4 s). A spare starts without a body and gets the whole request body through the stdin
 * control request `apply_flag_settings` just before its query frame, so every request still runs on its
 * own fresh process with lunR's exact body. A spare starts as soon as the current request has left (so the
 * two never compete for the CPU) and is dropped when the answer ends unless it stopped for tool use, since
 * only then do a tool result and another request follow. One spare per lunR session id; compaction
 * and other side calls pass none and run cold. POSIX only.
 */
interface Spare {
	key: string;
	process: ClaudeCodeProcess;
	timer: NodeJS.Timeout;
}

const spares = new Map<string, Spare>();
/** Spares still starting, by session id; a request that arrives meanwhile waits, as that is sooner than a cold start. */
const startingSpares = new Map<string, Promise<void>>();
/** Each spare holds about 200 MB; spares live only between a tool call and the next request. */
const MAX_SPARES = 3;
/**
 * A spare reads Claude Code's sign-in when it starts. Another Claude Code that refreshes the sign-in while the
 * spare waits could leave it with a stale token (untested), so a spare older than this is dropped.
 */
const SPARE_MAX_AGE_MS = 2 * 60 * 1000;
/** A spare can carry a history over the settings file limit: 2.1.310 accepted bodies up to 20 MiB. */
const SPARE_BODY_LIMIT = 20 * 1024 * 1024;
/**
 * Claude Code binaries that answered `apply_flag_settings` with an error, for example a pin that dropped or
 * changed it. Their requests go cold for the rest of the lunR process.
 */
const noSpares = new Set<string>();
/**
 * Late confirmations in a row per binary. 3 pause spares, since the machine is that busy or the binary ignores
 * the control request: for a minute, then twice as long after each further late one, up to 30 minutes. A
 * confirmed spare resets both.
 */
const lateSpares = new Map<string, { count: number; until: number; pause: number }>();
const LATE_SPARES_PAUSE = 3;
const LATE_SPARES_PAUSE_MS = 60 * 1000;
const LATE_SPARES_MAX_PAUSE_MS = 30 * 60 * 1000;

function sparesWork(command: string): boolean {
	return process.platform !== "win32" && !noSpares.has(command) && (lateSpares.get(command)?.until ?? 0) <= Date.now();
}

/** Records how a spare's confirmation went for `command`. */
function noteSpare(command: string, reason: SpareFailed["reason"] | "confirmed"): void {
	if (reason === "refused") noSpares.add(command);
	if (reason === "confirmed") lateSpares.delete(command);
	if (reason !== "late") return;
	const last = lateSpares.get(command) ?? { count: 0, until: 0, pause: 0 };
	if (last.count + 1 < LATE_SPARES_PAUSE) {
		lateSpares.set(command, { ...last, count: last.count + 1 });
		return;
	}
	const pause = last.pause ? Math.min(last.pause * 2, LATE_SPARES_MAX_PAUSE_MS) : LATE_SPARES_PAUSE_MS;
	// After the pause one more late confirmation is enough to pause again, for twice as long.
	lateSpares.set(command, { count: LATE_SPARES_PAUSE - 1, until: Date.now() + pause, pause });
}

/**
 * Everything fixed when Claude Code starts, so a spare fits a request only when these match: the binary
 * and its config directory, the model route (`--model`), the system prompt file, the tool list the MCP
 * endpoint serves, the output limit (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`) and the test upstream. The rest of
 * the body, history included, arrives with `apply_flag_settings`.
 */
function spareKey(connection: ExternalClaudeCodeCredential, request: ClaudeCodeRequest, upstream?: string): string {
	const { route, system, tools, maxTokens } = request;
	return JSON.stringify([connection.command, connection.configDir, route, system, tools, maxTokens, upstream]);
}

/** Stops the spare of one lunR session, or all spares; one still starting stops once it has started. */
function stopSpares(sessionId?: string): void {
	for (const id of startingSpares.keys()) if (sessionId === undefined || id === sessionId) startingSpares.delete(id);
	for (const [id, spare] of spares) {
		if (sessionId !== undefined && id !== sessionId) continue;
		spares.delete(id);
		clearTimeout(spare.timer);
		void discardProcess(spare.process);
	}
}
registerSessionResourceCleanup(stopSpares);
registerConversationCleanup(stopSpares);

/** Starts a spare for the next request of `sessionId`, unless it has one or the process cap is reached. */
async function prepareSpare(
	sessionId: string,
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
): Promise<void> {
	if (!sparesWork(connection.command) || spares.has(sessionId) || startingSpares.has(sessionId)) return;
	if (spares.size + startingSpares.size >= MAX_SPARES) return;
	// The entry identifies this start: a stopped start finds another entry (or none) and stops its own process.
	let starting: Promise<void> | undefined;
	const current = () => startingSpares.get(sessionId) === starting;
	starting = startSpare(sessionId, connection, request, upstream, current);
	startingSpares.set(sessionId, starting);
	try {
		await starting;
	} finally {
		if (current()) startingSpares.delete(sessionId);
	}
}

async function startSpare(
	sessionId: string,
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	upstream: string | undefined,
	current: () => boolean,
): Promise<void> {
	const started = await startClaudeCode(connection, request, upstream, "{}", true);
	if (!current()) {
		void discardProcess(started);
		return;
	}
	const timer = setTimeout(() => {
		if (spares.get(sessionId)?.process !== started) return;
		spares.delete(sessionId);
		void discardProcess(started);
	}, SPARE_MAX_AGE_MS);
	timer.unref();
	spares.set(sessionId, { key: spareKey(connection, request, upstream), process: started, timer });
	started.child.once("close", () => {
		if (spares.get(sessionId)?.process === started) stopSpares(sessionId);
	});
}

/** The session's spare when it fits `key`; a spare that does not is stopped. */
function takeSpare(sessionId: string, key: string): ClaudeCodeProcess | undefined {
	const spare = spares.get(sessionId);
	if (!spare) return undefined;
	spares.delete(sessionId);
	clearTimeout(spare.timer);
	const { child } = spare.process;
	if (spare.key === key && child.exitCode === null && child.signalCode === null) return spare.process;
	void discardProcess(spare.process);
	return undefined;
}

/**
 * `fetch` for the Anthropic SDK that sends each Messages request through lunR's pinned Claude Code
 * instead of HTTPS. With a session id, a request runs on that session's spare when one fits, and any doubt
 * about the spare sends it cold. Exported for tests, which point `upstream` at a loopback fixture.
 */
export function claudeCodeFetch(
	connection: ExternalClaudeCodeCredential,
	idleMs: number,
	upstream?: string,
	/** Called when a request's history is too large for the body and is replayed uncached. */
	onHistoryReplay?: () => void,
	sessionId?: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (_input, init) => {
		const signal = init?.signal ?? undefined;
		try {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			// A binary another lunR removed sends the request cold with the re-read login: its spares no longer fit.
			const current = await currentConnection(connection);
			const request = claudeCodeRequest(body, current);
			const live = sessionId && sparesWork(current.command) ? sessionId : undefined;
			// The spare starts once this request has left, so it never slows this one; it is dropped unless the
			// answer stops for tool use, after which a tool result and the next request follow.
			const nextRequest = live
				? {
						start: () => void prepareSpare(live, current, request, upstream).catch(() => {}),
						end: (toolUse: boolean) => {
							if (!toolUse) stopSpares(live);
						},
					}
				: undefined;
			if (live) await startingSpares.get(live)?.catch(() => {});
			const spare = live ? takeSpare(live, spareKey(current, request, upstream)) : undefined;
			// A spare gets its body through a control request, which carries up to SPARE_BODY_LIMIT of history.
			const onSpare =
				spare && ("messages" in request.extraBody ? request : claudeCodeRequest(body, current, SPARE_BODY_LIMIT));
			if (spare && onSpare && "messages" in onSpare.extraBody) {
				try {
					const response = await runClaudeCode(current, onSpare, signal, idleMs, upstream, {
						spare,
						nextRequest,
					});
					noteSpare(current.command, "confirmed");
					return response;
				} catch (error) {
					if (!(error instanceof SpareFailed)) throw error;
					noteSpare(current.command, error.reason);
				}
			} else if (spare) void discardProcess(spare);
			if (!("messages" in request.extraBody)) onHistoryReplay?.();
			return await runClaudeCode(current, request, signal, idleMs, upstream, { nextRequest });
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
 * Tool references and deferred tools pass through Claude Code unchanged. Eager tool input and sampling
 * stay off because Claude Code manages those parts of its own request. lunR adds no cache markers; the
 * bridge places the history marker itself.
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
	let replayed = false;
	const client = new Anthropic({
		// Never sent anywhere: the fetch override replaces HTTP, and Claude Code supplies its own sign-in.
		apiKey: "claude-code-subscription",
		maxRetries: 0,
		fetch: claudeCodeFetch(
			connection,
			idleMs,
			upstream,
			() => {
				replayed = true;
			},
			options.sessionId,
		),
	});
	const transportModel: Model<"anthropic-messages"> = {
		...model,
		compat: {
			...model.compat,
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
	const source = simple
		? streamSimpleMessages(transportModel, context, transportOptions)
		: streamMessages(transportModel, context, transportOptions);
	// The final message records an uncached replay, so lunR can tell the user once and show it in /context.
	const output = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (replayed && (event.type === "done" || event.type === "error"))
				appendAssistantMessageDiagnostic(event.type === "done" ? event.message : event.error, {
					type: CLAUDE_CODE_HISTORY_REPLAYED,
					timestamp: Date.now(),
				});
			output.push(event);
		}
		output.end();
	})();
	return output;
}
