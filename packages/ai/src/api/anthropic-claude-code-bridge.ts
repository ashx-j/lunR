import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExternalClaudeCodeCredential } from "../auth/types.ts";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ToolCall,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

const WORKER = fileURLToPath(
	new URL("../../vendor/hermes-claude-subscription-directsdk/lunr_bridge.py", import.meta.url),
);
const MAX_RECORD = 64 * 1024 * 1024;
const CONFLICTS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_EXTRA_BODY",
] as const;
const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

export function claudeCodeEnvironment(configDir?: string, strict = true): Record<string, string> {
	const conflicting = CONFLICTS.filter((name) => {
		const value = process.env[name];
		return (
			value &&
			((name !== "CLAUDE_CODE_USE_BEDROCK" &&
				name !== "CLAUDE_CODE_USE_VERTEX" &&
				name !== "CLAUDE_CODE_USE_FOUNDRY") ||
				!["0", "false", "no", "off"].includes(value.toLowerCase()))
		);
	});
	if (strict && conflicting.length)
		throw new Error(`Claude Code subscription refuses conflicting environment variables: ${conflicting.join(", ")}`);
	if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
		throw new Error("Claude Code subscription requires TLS certificate verification");
	const env = Object.fromEntries(
		ENV_ALLOWLIST.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
	);
	if (configDir) env.CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR = configDir;
	return env;
}

function contentHash(content: AssistantMessage["content"]): string {
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function history(
	context: Context,
	model: Model<Api>,
	connection: ExternalClaudeCodeCredential,
): { messages: unknown[]; tools: unknown[] } {
	const messages: Record<string, unknown>[] = context.systemPrompt
		? [{ role: "system", content: context.systemPrompt }]
		: [];
	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({
				role: "user",
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((block) =>
								block.type === "text"
									? { type: "text", text: block.text }
									: {
											type: "image_url",
											image_url: { url: `data:${block.mimeType};base64,${block.data}` },
										},
							),
			});
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const calls = message.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map((block) => ({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments) },
				}));
			const projection = {
				content: text.trim(),
				tool_calls: calls.map((call) => ({
					id: call.id,
					name: call.function.name,
					input: JSON.parse(call.function.arguments),
				})),
			};
			const carrier =
				message.provider === "anthropic" &&
				message.model === model.id &&
				message.claudeCodeCarrier?.version === 1 &&
				connection.accountFingerprint &&
				message.claudeCodeCarrier.accountFingerprint === connection.accountFingerprint &&
				message.claudeCodeCarrier.contentHash === contentHash(message.content) &&
				JSON.stringify(message.claudeCodeCarrier.projection) === JSON.stringify(projection)
					? [{ type: "claude-subscription-directsdk-experimental.native_assistant", ...message.claudeCodeCarrier }]
					: [];
			messages.push({ role: "assistant", content: text, tool_calls: calls, reasoning_details: carrier });
		} else {
			if (message.content.some((block) => block.type !== "text"))
				throw new Error("Claude Code subscription supports text tool results only");
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				is_error: message.isError,
			});
		}
	}
	const tools = (context.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
	return { messages, tools };
}

function validateOptions(model: Model<Api>, options: StreamOptions | SimpleStreamOptions): void {
	if (!options.externalClaudeCode)
		throw new Error("Claude Code subscription setup is required. Run /login anthropic.");
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
	const anthro = options as StreamOptions & {
		toolChoice?: unknown;
		client?: unknown;
		extraBody?: unknown;
		thinkingBudgetTokens?: unknown;
		stopSequences?: unknown;
		thinkingEnabled?: boolean;
		effort?: string;
		thinkingDisplay?: unknown;
		interleavedThinking?: unknown;
	};
	if (
		(anthro.toolChoice && anthro.toolChoice !== "auto") ||
		anthro.client ||
		anthro.extraBody ||
		anthro.thinkingBudgetTokens ||
		anthro.stopSequences ||
		anthro.thinkingDisplay !== undefined ||
		anthro.interleavedThinking !== undefined
	) {
		throw new Error("Claude Code subscription does not support forced tools or native request overrides");
	}
	if (options.temperature !== undefined)
		throw new Error("Claude Code subscription does not support sampling overrides");
}

type WorkerEvent = { v: 1; requestId: string; type: string; text?: unknown; pid?: unknown; response?: unknown };

function parseWorkerRecord(line: string, requestId: string): WorkerEvent {
	if (Buffer.byteLength(line) > MAX_RECORD) throw new Error("Claude Code bridge record exceeds size limit");
	const value: unknown = JSON.parse(line);
	if (
		!value ||
		typeof value !== "object" ||
		!("v" in value) ||
		value.v !== 1 ||
		!("requestId" in value) ||
		value.requestId !== requestId ||
		!("type" in value) ||
		typeof value.type !== "string"
	) {
		throw new Error("Invalid Claude Code bridge record");
	}
	return value as WorkerEvent;
}

export async function stopNative(pid: number): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid < 1) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			const timer = setTimeout(() => {
				killer.kill();
				resolve();
			}, 3000);
			killer.once("error", () => {
				clearTimeout(timer);
				resolve();
			});
			killer.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* Already exited. */
		}
	}
}

function validatedCompletion(
	value: unknown,
	model: Model<Api>,
	text: string,
	thinking: string,
): {
	content: AssistantMessage["content"];
	carrier: AssistantMessage["claudeCodeCarrier"];
	usage: Usage;
	responseId: string;
	reason: "stop" | "length" | "toolUse";
} {
	if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices))
		throw new Error("Invalid native completion");
	const response = value as Record<string, unknown> & {
		choices: { finish_reason: unknown; message: Record<string, unknown> }[];
		usage: Record<string, unknown>;
	};
	const choice = response.choices[0];
	if (
		!choice ||
		!["stop", "length", "tool_calls"].includes(String(choice.finish_reason)) ||
		(typeof choice.message?.content !== "string" && choice.message?.content !== null) ||
		(choice.message.content ?? "") !== text ||
		(choice.message.reasoning_content ?? "") !== thinking
	)
		throw new Error("Native completion differs from streamed content");
	const rawCalls = choice.message.tool_calls ?? [];
	if (!Array.isArray(rawCalls)) throw new Error("Invalid native tool calls");
	const calls: ToolCall[] = rawCalls.map((call) => {
		if (
			!call ||
			typeof call !== "object" ||
			typeof call.id !== "string" ||
			typeof call.function?.name !== "string" ||
			typeof call.function?.arguments !== "string"
		)
			throw new Error("Invalid native tool call");
		const args: unknown = JSON.parse(call.function.arguments);
		if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid native tool arguments");
		return { type: "toolCall", id: call.id, name: call.function.name, arguments: args as Record<string, unknown> };
	});
	const native = response.usage;
	if (
		!native ||
		typeof native.native_admission !== "object" ||
		native.native_admission === null ||
		(native.native_admission as { upstream_requests?: unknown }).upstream_requests !== 1
	)
		throw new Error("Native one-request admission not verified");
	if (
		!native ||
		!Number.isFinite(native.prompt_tokens) ||
		!Number.isFinite(native.completion_tokens) ||
		!Number.isFinite(native.cache_creation_input_tokens) ||
		!("prompt_tokens_details" in native)
	)
		throw new Error("Missing native usage");
	const cached = (native.prompt_tokens_details as { cached_tokens?: unknown }).cached_tokens;
	if (!Number.isFinite(cached)) throw new Error("Missing native cache usage");
	const usage: Usage = {
		input: Number(native.prompt_tokens) - Number(cached) - Number(native.cache_creation_input_tokens),
		output: Number(native.completion_tokens),
		cacheRead: Number(cached),
		cacheWrite: Number(native.cache_creation_input_tokens),
		totalTokens: Number(native.total_tokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (usage.input < 0 || usage.output < 0) throw new Error("Invalid native usage");
	calculateCost(model, usage);
	const details = choice.message.reasoning_details;
	const carrier = Array.isArray(details)
		? details.find((entry) => entry?.type === "claude-subscription-directsdk-experimental.native_assistant")
		: undefined;
	const projection = {
		content: text.trim(),
		tool_calls: calls.map((call) => ({ id: call.id, name: call.name, input: call.arguments })),
	};
	if (
		!carrier ||
		carrier.version !== 1 ||
		!Array.isArray(carrier.messages) ||
		JSON.stringify(carrier.projection) !== JSON.stringify(projection)
	)
		throw new Error("Invalid native replay carrier");
	return {
		content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
		carrier: { version: 1, messages: carrier.messages, projection },
		usage,
		responseId: String(response.id ?? ""),
		reason: choice.finish_reason === "tool_calls" ? "toolUse" : choice.finish_reason === "length" ? "length" : "stop",
	};
}

export function streamClaudeCode(
	model: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions = {},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	void (async () => {
		let child: ChildProcessWithoutNullStreams | undefined;
		let nativePid: number | undefined;
		let nativeCleanup: Promise<void> | undefined;
		const stopNativeOnce = () => {
			if (nativePid === undefined) return Promise.resolve();
			nativeCleanup ??= stopNative(nativePid);
			return nativeCleanup;
		};
		let timer: NodeJS.Timeout | undefined;
		let abortTimer: NodeJS.Timeout | undefined;
		let started = false;
		let complete = false;
		let buffer = "";
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let text = "";
		let thinking = "";
		let activeIndex = -1;
		let activeType: "text" | "thinking" | undefined;
		try {
			validateOptions(model, options);
			if (options.signal?.aborted) throw new Error("Claude Code request cancelled");
			const connection = options.externalClaudeCode!;
			const env = claudeCodeEnvironment(connection.configDir);
			const input = history(context, model, connection);
			const anthropicOptions = options as StreamOptions & { thinkingEnabled?: boolean; effort?: string };
			const reasoning =
				"reasoning" in options && options.reasoning
					? { enabled: true, effort: options.reasoning }
					: anthropicOptions.thinkingEnabled !== undefined || anthropicOptions.effort
						? {
								enabled: anthropicOptions.thinkingEnabled ?? true,
								...(anthropicOptions.effort ? { effort: anthropicOptions.effort } : {}),
							}
						: undefined;
			const requestId = randomUUID();
			child = spawn(connection.python, ["-s", "-B", "-u", WORKER], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env,
			});
			const worker = child;
			worker.stderr.resume();
			worker.stdin.on("error", () => {});
			const idleMs = Math.min(300_000, Math.max(1000, options.timeoutMs ?? 180_000));
			const record = {
				v: 1,
				requestId,
				type: "start",
				command: connection.command,
				env,
				model: model.id,
				...input,
				extraBody: {
					...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
					...(reasoning ? { reasoning } : {}),
				},
				timeout: Math.round(idleMs / 1000),
			};
			const payload = JSON.stringify(record);
			if (Buffer.byteLength(payload) > MAX_RECORD) throw new Error("Claude Code request exceeds size limit");
			worker.stdin.write(`${payload}\n`);
			let cancelSent = false;
			let timedOut = false;
			const abort = () => {
				if (cancelSent) return;
				cancelSent = true;
				if (timer) clearTimeout(timer);
				worker.stdin.write(`${JSON.stringify({ v: 1, requestId, type: "cancel" })}\n`);
				abortTimer = setTimeout(() => {
					void stopNativeOnce().then(() => worker.kill());
				}, 2500);
			};
			const resetDeadline = () => {
				if (cancelSent) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timedOut = true;
					abort();
				}, idleMs);
			};
			timer = setTimeout(
				() => {
					timedOut = true;
					abort();
				},
				Math.min(30_000, idleMs),
			);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			try {
				await new Promise<void>((resolve, reject) => {
					worker.on("error", reject);
					worker.stdout.on("data", (data: Buffer) => {
						try {
							buffer += decoder.decode(data, { stream: true });
							if (Buffer.byteLength(buffer) > MAX_RECORD)
								throw new Error("Claude Code bridge record exceeds size limit");
							for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
								const event = parseWorkerRecord(buffer.slice(0, newline), requestId);
								buffer = buffer.slice(newline + 1);
								if (event.type === "ready" || event.type === "replay_progress") resetDeadline();
								else if (
									event.type === "native_started" &&
									Number.isSafeInteger(event.pid) &&
									Number(event.pid) > 0
								) {
									nativePid = Number(event.pid);
									resetDeadline();
								} else if (
									cancelSent &&
									["start", "text_delta", "thinking_delta", "complete"].includes(event.type)
								)
									continue;
								else if (event.type === "start") {
									if (started) throw new Error("Duplicate Claude Code stream start");
									started = true;
									stream.push({ type: "start", partial: output });
								} else if (event.type === "text_delta" || event.type === "thinking_delta") {
									if (!started || complete || typeof event.text !== "string")
										throw new Error("Invalid Claude Code stream delta");
									resetDeadline();
									const kind = event.type === "text_delta" ? "text" : "thinking";
									if (activeType !== kind) {
										if (activeType === "text")
											stream.push({
												type: "text_end",
												contentIndex: activeIndex,
												content: (output.content[activeIndex] as { text: string }).text,
												partial: output,
											});
										if (activeType === "thinking")
											stream.push({
												type: "thinking_end",
												contentIndex: activeIndex,
												content: (output.content[activeIndex] as { thinking: string }).thinking,
												partial: output,
											});
										activeIndex = output.content.length;
										activeType = kind;
										if (kind === "text") {
											output.content.push({ type: "text", text: "" });
											stream.push({ type: "text_start", contentIndex: activeIndex, partial: output });
										} else {
											output.content.push({ type: "thinking", thinking: "" });
											stream.push({ type: "thinking_start", contentIndex: activeIndex, partial: output });
										}
									}
									const block = output.content[activeIndex];
									if (kind === "text" && block?.type === "text") {
										text += event.text;
										block.text += event.text;
										stream.push({
											type: "text_delta",
											contentIndex: activeIndex,
											delta: event.text,
											partial: output,
										});
									}
									if (kind === "thinking" && block?.type === "thinking") {
										thinking += event.text;
										block.thinking += event.text;
										stream.push({
											type: "thinking_delta",
											contentIndex: activeIndex,
											delta: event.text,
											partial: output,
										});
									}
								} else if (event.type === "complete") {
									if (!started || complete) throw new Error("Invalid Claude Code completion order");
									const result = validatedCompletion(event.response, model, text, thinking);
									complete = true;
									if (activeType === "text")
										stream.push({
											type: "text_end",
											contentIndex: activeIndex,
											content: (output.content[activeIndex] as { text: string }).text,
											partial: output,
										});
									if (activeType === "thinking")
										stream.push({
											type: "thinking_end",
											contentIndex: activeIndex,
											content: (output.content[activeIndex] as { thinking: string }).thinking,
											partial: output,
										});
									output.content = [
										...output.content.filter((block) => block.type !== "toolCall"),
										...result.content.filter((block) => block.type === "toolCall"),
									];
									output.claudeCodeCarrier = result.carrier && {
										...result.carrier,
										contentHash: contentHash(output.content),
										accountFingerprint: connection.accountFingerprint,
									};
									output.responseId = result.responseId;
									output.usage = result.usage;
									output.stopReason = result.reason;
									for (let index = 0; index < output.content.length; index++) {
										const block = output.content[index];
										if (block.type === "toolCall") {
											stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
											stream.push({
												type: "toolcall_end",
												contentIndex: index,
												toolCall: block,
												partial: output,
											});
										}
									}
								} else if (event.type === "cancelled" && cancelSent) {
								} else if (event.type === "error" || event.type === "cancelled")
									throw new Error(
										"Claude Code request failed. Check subscription setup and native CLI compatibility.",
									);
								else throw new Error("Unknown Claude Code bridge event");
							}
						} catch (error) {
							reject(error);
						}
					});
					worker.on("close", () => {
						try {
							decoder.decode();
							if (complete || cancelSent) resolve();
							else reject(new Error("Claude Code bridge exited without a validated completion"));
						} catch (error) {
							reject(error);
						}
					});
				});
			} finally {
				options.signal?.removeEventListener("abort", abort);
			}
			if (options.signal?.aborted || timedOut) throw new Error("Claude Code request cancelled or timed out");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		} catch (error) {
			output.content = [];
			output.claudeCodeCarrier = undefined;
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			const detail =
				error instanceof Error &&
				(error.message.startsWith("Claude Code subscription setup is required") ||
					error.message.startsWith("Claude Code subscription does not support") ||
					error.message.startsWith("Claude Code subscription refuses conflicting") ||
					error.message.startsWith("Claude Code subscription requires TLS"))
					? error.message
					: undefined;
			output.errorMessage = options.signal?.aborted
				? "Claude Code request cancelled"
				: (detail ??
					"Claude Code request failed. Run /login anthropic to check setup and Claude Code version 2.1.263.");
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			if (timer) clearTimeout(timer);
			if (abortTimer) clearTimeout(abortTimer);
			if (child) {
				if (!complete || child.exitCode === null) await stopNativeOnce();
				if (child.exitCode === null) child.kill();
			}
		}
	})();
	return stream;
}
