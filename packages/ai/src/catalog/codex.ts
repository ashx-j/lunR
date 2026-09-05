import type { Model, ThinkingLevelMap } from "../types.ts";

// Version of the Codex discovery protocol we implement, independent of lunR's package version.
export const CODEX_CATALOG_CLIENT_VERSION = "0.153.4";
export const CODEX_RELEASE_URL = "https://registry.npmjs.org/@openai/codex/latest";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function codexModelsUrl(baseUrl: string, clientVersion = CODEX_CATALOG_CLIENT_VERSION): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base.endsWith("/codex") ? base : `${base}/codex`}/models?client_version=${encodeURIComponent(clientVersion)}`;
}

/** Fetch only a release number, never npm code. Backend visibility is version-gated. */
export async function resolveCodexCatalogVersion(
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	fallback = CODEX_CATALOG_CLIENT_VERSION,
): Promise<string> {
	try {
		const response = await fetchImpl(CODEX_RELEASE_URL, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
			headers: { accept: "application/json" },
		});
		if (!response.ok) return fallback;
		const value = (await response.json()) as { version?: unknown } | null;
		if (typeof value?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) return fallback;
		return value.version;
	} catch {
		return fallback;
	}
}

/** Parse only model capabilities; server prompt templates and tool instructions are not imported. */
export function parseCodexCatalog(payload: unknown, baseUrl: string): Model<"openai-codex-responses">[] {
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
		throw new Error("Invalid Codex model catalog: expected models array");
	}
	const models = new Map<string, Model<"openai-codex-responses">>();
	for (const value of (payload as { models: unknown[] }).models) {
		if (!value || typeof value !== "object") throw new Error("Invalid Codex model entry");
		const row = value as Record<string, unknown>;
		if (typeof row.slug !== "string" || !row.slug.trim()) throw new Error("Codex model is missing its slug");
		const supplied: NonNullable<Model<any>["catalog"]>["supplied"] = [];
		const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
		const context = positive(row.context_window) ? row.context_window : row.max_context_window;
		if (positive(context)) supplied.push("contextWindow");
		if (positive(row.max_output_tokens)) supplied.push("maxTokens");
		const name = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name : row.slug;
		if (name !== row.slug) supplied.push("name");
		const input = Array.isArray(row.input_modalities)
			? row.input_modalities.filter((item): item is "text" | "image" => item === "text" || item === "image")
			: [];
		if (input.length) supplied.push("input");
		let thinkingLevelMap: ThinkingLevelMap | undefined;
		const efforts = Array.isArray(row.supported_reasoning_levels)
			? row.supported_reasoning_levels.flatMap((item) =>
					item && typeof item.effort === "string" ? [item.effort as string] : [],
				)
			: [];
		if (Array.isArray(row.supported_reasoning_levels)) {
			thinkingLevelMap = Object.fromEntries(
				LEVELS.map((level) => [
					level,
					level === "off" && efforts.includes("none") ? "none" : efforts.includes(level) ? level : null,
				]),
			);
			supplied.push("reasoning", "thinkingLevelMap");
		}
		models.set(row.slug, {
			id: row.slug,
			name,
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl,
			reasoning: efforts.length > 0,
			thinkingLevelMap,
			input: input.length ? input : ["text"],
			contextWindow: positive(context) ? (context as number) : 128000,
			maxTokens: positive(row.max_output_tokens) ? (row.max_output_tokens as number) : 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			catalog: {
				source: "provider",
				supplied,
				pricing: "unknown",
				reasoningLevels: efforts,
				hidden: row.visibility !== "list",
			},
		});
	}
	if (!models.size) throw new Error("Codex returned an empty model catalog; retaining cached models");
	return [...models.values()];
}
