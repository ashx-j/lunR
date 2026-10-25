/**
 * OpenCode Zen / Go helpers for the catalog generator.
 * Availability comes from GET /v1/models; models.dev supplies metadata.
 */

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
