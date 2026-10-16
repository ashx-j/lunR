import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_UPDATE_REQUIRED } from "../auth/anthropic-route.ts";
import type { ExternalClaudeCodeCredential } from "../auth/types.ts";
import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { claudeCodeRoute } from "../utils/claude-code-release.ts";
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
const MAX_ERROR_BODY = 64 * 1024;

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

/** Validates the request lunR's Messages implementation built and maps it onto Claude Code's inputs. */
function claudeCodeRequest(body: unknown): ClaudeCodeRequest {
	if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages))
		throw new Error("Invalid Claude Code request");
	const unsupported = Object.keys(body).filter((key) => !SUPPORTED_PARAMS.has(key));
	if (unsupported.length) throw new Error(`Claude Code subscription does not support ${unsupported.join(", ")}`);
	if (body.tool_choice !== undefined && !(isRecord(body.tool_choice) && body.tool_choice.type === "auto"))
		throw new Error("Claude Code subscription does not support forced tool choice");
	const route = claudeCodeRoute(body.model);
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

/** Explains a Claude Code exit that never reached Anthropic, without passing native text through. */
function stoppedBeforeRequest(result: ClaudeCodeEvent | undefined): string {
	if (!result) return "Claude Code exited before contacting Anthropic. Run /login anthropic to check the connection.";
	const detail = typeof result.result === "string" ? result.result : "";
	if (/log ?in|authenticat|oauth|credential|api key/i.test(detail))
		return "Claude Code is not signed in to a Claude subscription. Run /login anthropic.";
	return `Claude Code stopped before contacting Anthropic (${String(result.subtype)}). Run /login anthropic to check the connection.`;
}

/** Strips the MCP prefix from tool calls in one SSE event and rejects tools lunR did not offer. */
function renameToolEvent(event: string, inventory: ReadonlySet<string>): string {
	if (!event.includes('"tool_use"')) return event;
	return event.replace(/^data: ?(.*)$/m, (line, json: string) => {
		const data: unknown = JSON.parse(json);
		if (
			!isRecord(data) ||
			data.type !== "content_block_start" ||
			!isRecord(data.content_block) ||
			data.content_block.type !== "tool_use"
		)
			return line;
		const name = data.content_block.name;
		const tool = typeof name === "string" && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : "";
		if (!inventory.has(tool)) throw new Error("Claude Code returned a tool outside lunR's tool list");
		return `data: ${JSON.stringify({ ...data, content_block: { ...data.content_block, name: tool } })}`;
	});
}

/** Passes the upstream SSE body through, renaming tool calls event by event and cleaning up once it ends. */
function renameToolCalls(
	body: ReadableStream<Uint8Array>,
	inventory: ReadonlySet<string>,
	finish: () => Promise<void>,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	const rename = (text: string) =>
		text
			.split(/(\r?\n\r?\n)/)
			.map((part, index) => (index % 2 ? part : renameToolEvent(part, inventory)))
			.join("");
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					pending += decoder.decode();
					if (pending) controller.enqueue(encoder.encode(rename(pending)));
					controller.close();
					await finish();
					return;
				}
				pending += decoder.decode(value, { stream: true });
				let boundary = -1;
				for (const match of pending.matchAll(/\r?\n\r?\n/g)) boundary = match.index + match[0].length;
				if (boundary > 0) {
					controller.enqueue(encoder.encode(rename(pending.slice(0, boundary))));
					pending = pending.slice(boundary);
				}
			} catch (error) {
				controller.error(error);
				await reader.cancel().catch(() => {});
				await finish();
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await finish();
		},
	});
}

async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		if (size >= limit) continue;
		chunks.push(chunk.subarray(0, limit - size));
		size += chunks[chunks.length - 1].length;
	}
	return Buffer.concat(chunks);
}

/** Failures before any upstream answer travel as an SSE error event, so the Messages stream reports the text unchanged. */
function localFailure(message: string): Response {
	return new Response(`event: error\ndata: ${message.replace(/\s*\n\s*/g, " ")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function runClaudeCode(
	connection: ExternalClaudeCodeCredential,
	request: ClaudeCodeRequest,
	signal: AbortSignal | undefined,
	idleMs: number,
	upstream: string | undefined,
): Promise<Response> {
	if (!existsSync(connection.command))
		throw new Error("lunR's Claude Code is missing. Run /login anthropic to download it again.");
	const loopback = await ClaudeCodeLoopback.open({ timeoutMs: idleMs, tools: request.tools, upstream });
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-")).catch((error: unknown) => {
		loopback.close();
		throw error;
	});
	let pid: number | undefined;
	let cleanup: Promise<void> | undefined;
	const finish = () => {
		cleanup ??= (async () => {
			loopback.close();
			await stopProcessTree(pid);
			// Windows can hold the working directory briefly after the process tree ends.
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		})();
		return cleanup;
	};
	// An abort while lunR reads the body must still end Claude Code and close the relay.
	signal?.addEventListener("abort", () => void finish(), { once: true });
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
			ANTHROPIC_BASE_URL: loopback.baseUrl,
			...(request.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) } : {}),
		};
		// Cleanup that already ran during the writes above had no process to stop, so never start one.
		if (signal?.aborted) throw new Error("Claude Code request cancelled");
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
			directory,
		);
		pid = child.pid;
		// Claude Code exits only after the relay has delivered the whole upstream answer, so cleanup is safe here too.
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

		const events = claudeCodeEvents(child.stdout);
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

		const outcome = await within(
			Promise.race([
				loopback.response.then((response) => ({ response })),
				nextResult(events).then((result) => ({ result })),
			]),
			"Claude Code request timed out.",
		);
		if (!("response" in outcome)) throw new Error(stoppedBeforeRequest(outcome.result));
		const { response } = outcome;
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		if (response.status !== 200) {
			// The upstream error keeps its status so retries and context-overflow handling match the API-key route.
			const body = await readLimited(response.body, MAX_ERROR_BODY);
			await finish();
			return new Response(body, { status: response.status, headers });
		}
		const inventory = new Set(request.tools.map((tool) => tool.name));
		return new Response(renameToolCalls(response.body, inventory, finish), { status: 200, headers });
	} catch (error) {
		await finish();
		throw error;
	}
}

/**
 * `fetch` for the Anthropic SDK that sends each Messages request through lunR's pinned Claude Code
 * instead of HTTPS. Exported for tests, which point `upstream` at a loopback fixture.
 */
export function claudeCodeFetch(
	connection: ExternalClaudeCodeCredential,
	idleMs: number,
	upstream?: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (_input, init) => {
		const signal = init?.signal ?? undefined;
		try {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			return await runClaudeCode(connection, claudeCodeRequest(body), signal, idleMs, upstream);
		} catch (error) {
			if (signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			// Node's connection errors read like "connect ECONNREFUSED"; name them so lunR's retry rules see a network error.
			return localFailure(
				/^(?:connect|getaddrinfo|read|write) E[A-Z]+|socket hang up/.test(message)
					? `Claude Code network error: ${message}`
					: message,
			);
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
	if (connection.version !== 2) throw new Error(CLAUDE_CODE_UPDATE_REQUIRED);
	const idleMs = Math.min(300_000, Math.max(1000, options.timeoutMs ?? 180_000));
	const client = new Anthropic({
		// Never sent anywhere: the fetch override replaces HTTP, and Claude Code supplies its own sign-in.
		apiKey: "claude-code-subscription",
		maxRetries: 0,
		fetch: claudeCodeFetch(connection, idleMs, upstream),
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
