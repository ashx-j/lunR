/**
 * OpenCode Zen / Go catalog helpers for generate-models.ts.
 * Live source of truth is GET /v1/models; models.dev supplies metadata.
 */

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

export type OpencodeApi =
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "openai-completions";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an OpenAI-style `{ data: [{ id }] }` (or bare array) into model ids. */
export function parseZenModelIds(payload: unknown): Set<string> {
	const entries =
		isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (typeof entry === "string" && entry.trim()) {
			ids.add(entry.trim());
			continue;
		}
		if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
			ids.add(entry.id.trim());
		}
	}
	return ids;
}

/**
 * When a live Zen list is available, include a models.dev row iff it is
 * tool-capable and still served — even if models.dev marked it deprecated.
 * When the live list is missing, keep the old skip-deprecated behavior.
 */
export function shouldIncludeOpencodeModel(
	modelId: string,
	options: {
		toolCall: boolean;
		liveIds: ReadonlySet<string> | null;
		deprecated?: boolean;
	},
): boolean {
	if (!modelId || options.toolCall !== true) return false;
	if (options.liveIds) return options.liveIds.has(modelId);
	return options.deprecated !== true;
}

export function resolveOpencodeApi(args: { npm?: string; modelId: string }): OpencodeApi {
	if (args.npm === "@ai-sdk/openai") return "openai-responses";
	if (args.npm === "@ai-sdk/anthropic") return "anthropic-messages";
	if (args.npm === "@ai-sdk/google") return "google-generative-ai";
	if (args.npm === "@ai-sdk/alibaba" || args.npm === "@ai-sdk/openai-compatible" || args.npm) {
		return "openai-completions";
	}
	return inferOpencodeApiFromModelId(args.modelId);
}

/**
 * Last-resort API guess when a live Zen id has no models.dev npm field.
 * Matches the endpoint table on https://opencode.ai/docs/zen/
 */
export function inferOpencodeApiFromModelId(modelId: string): OpencodeApi {
	const id = modelId.toLowerCase();
	if (id.startsWith("claude-") || id.startsWith("qwen")) return "anthropic-messages";
	if (id.startsWith("gemini-")) return "google-generative-ai";
	if (id.startsWith("gpt-") || id.startsWith("grok-") || id.startsWith("muse-spark-")) {
		return "openai-responses";
	}
	return "openai-completions";
}

export function opencodeBaseUrl(basePath: string, api: OpencodeApi): string {
	// Anthropic SDK appends /v1/messages to baseURL.
	if (api === "anthropic-messages") return basePath;
	return `${basePath.replace(/\/+$/u, "")}/v1`;
}

export function isZeroCost(cost: { input?: number; output?: number } | undefined): boolean {
	return (cost?.input ?? 0) === 0 && (cost?.output ?? 0) === 0;
}

/** Free / contributor-free rows that Zen serves on the Responses API. */
export function opencodeFreeModelApi(modelId: string): OpencodeApi {
	if (modelId === "muse-spark-1.2-contributor-free") return "openai-responses";
	return "openai-completions";
}
