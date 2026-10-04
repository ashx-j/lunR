import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Local heuristic, not a provider tokenizer. Non-ASCII text often needs more tokens. */
export function estimateTextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if (character.codePointAt(0)! <= 0x7f) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / CHARS_PER_TOKEN + nonAscii);
}

/** Only the stable request prefix; conversation growth is handled separately. */
export function getContextFingerprint(context: Pick<Context, "systemPrompt" | "tools">): string {
	const serialized = safeJsonStringify([context.systemPrompt ?? "", context.tools ?? []]);
	let hash = 2166136261;
	for (let i = 0; i < serialized.length; i++) hash = Math.imul(hash ^ serialized.charCodeAt(i), 16777619);
	return `${serialized.length}:${hash >>> 0}`;
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return estimateTextTokens(content);
	return content.reduce(
		(sum, block) =>
			sum + (block.type === "text" ? estimateTextTokens(block.text) : ESTIMATED_IMAGE_CHARS / CHARS_PER_TOKEN),
		0,
	);
}

export function estimateMessageTokens(message: Message): number {
	if (message.role === "user" || message.role === "toolResult")
		return estimateTextAndImageContentTokens(message.content);
	return message.content.reduce(
		(tokens, block) =>
			tokens +
			estimateTextTokens(
				block.type === "text"
					? block.text
					: block.type === "thinking"
						? block.thinking
						: block.name + safeJsonStringify(block.arguments),
			),
		0,
	);
}

function getLastAssistantUsageInfo(
	messages: readonly Message[],
	fingerprint?: string,
): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				(fingerprint === undefined ||
					assistant.usage.contextFingerprint === undefined ||
					assistant.usage.contextFingerprint === fingerprint) &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

function estimateMessages(messages: readonly Message[], fingerprint?: string): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages, fingerprint);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
	if (isMessageArray(context)) return estimateMessages(context);

	const estimate = estimateMessages(context.messages, getContextFingerprint(context));
	if (estimate.lastUsageIndex !== null) {
		const addedNames = new Set(
			context.messages
				.slice(estimate.lastUsageIndex + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
		return {
			tokens: estimate.tokens + addedToolTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedToolTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
