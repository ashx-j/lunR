/**
 * xAI Grok 4.x thinking and transport overlays.
 * Used by generate-models.ts. Do not hand-edit catalog JSON for these maps.
 *
 * Docs (https://docs.x.ai/developers/model-capabilities/text/reasoning):
 * - grok-4.5: low / medium / high (cannot disable). xhigh is treated as high.
 * - grok-4.6+: low / medium / high / xhigh (cannot disable).
 * - grok-4.5+ uses the Responses API (encrypted thinking, streamed summaries).
 *   Older grok-4.x stays on Chat Completions. Named Completions exceptions go in
 *   XAI_RESPONSES_EXCLUDED_MODEL_IDS, not a frozen allowlist of current ids.
 */
export function parseXaiGrok4Minor(modelId: string): number | undefined {
	const match = /^grok-(\d+)\.(\d+)/i.exec(modelId);
	if (!match) return undefined;
	if (Number(match[1]) !== 4) return undefined;
	return Number(match[2]);
}

/** First Grok 4 minor that uses Responses. grok-4.3 and earlier stay on Completions. */
export const XAI_RESPONSES_MIN_MINOR = 5;

/** Completions-only exceptions among grok-4.5+ ids. Empty: new flagships default to Responses. */
export const XAI_RESPONSES_EXCLUDED_MODEL_IDS = new Set<string>();

export const XAI_RESPONSES_COMPAT = {
	supportsLongCacheRetention: false,
} as const;

export function shouldUseXaiResponsesApi(modelId: string): boolean {
	if (XAI_RESPONSES_EXCLUDED_MODEL_IDS.has(modelId)) return false;
	const minor = parseXaiGrok4Minor(modelId);
	return minor !== undefined && minor >= XAI_RESPONSES_MIN_MINOR;
}

/** off/minimal unsupported; no native xhigh. */
export const XAI_GROK45_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;

/** off/minimal unsupported; native xhigh. */
export const XAI_GROK46_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	xhigh: "xhigh",
} as const;

type XaiOverlayModel = {
	id: string;
	provider?: string;
	api?: string;
	thinkingLevelMap?: object;
	compat?: object;
};

function thinkingLevelMapForMinor(minor: number): object {
	if (minor === 5) return XAI_GROK45_THINKING_LEVEL_MAP;
	return XAI_GROK46_THINKING_LEVEL_MAP;
}

/**
 * Stamp Grok 4.x effort maps and Responses transport onto any catalog layer so a
 * stale shard cannot hide xhigh or keep grok-4.5+ on Chat Completions.
 */
export function withXaiEffortMetadata<T extends { id: string; provider?: string; api?: string }>(model: T): T {
	if (model.provider !== "xai") return model;
	const minor = parseXaiGrok4Minor(model.id);
	const current = model as T & XaiOverlayModel;
	if (shouldUseXaiResponsesApi(model.id) && minor !== undefined) {
		const thinkingLevelMap = { ...current.thinkingLevelMap, ...thinkingLevelMapForMinor(minor) };
		if (model.api === "openai-responses") {
			return {
				...model,
				thinkingLevelMap,
				compat: { ...current.compat, ...XAI_RESPONSES_COMPAT },
			};
		}
		return {
			...model,
			api: "openai-responses",
			thinkingLevelMap,
			// Completions compat (supportsDeveloperRole: false, …) must not leak onto Responses.
			compat: { ...XAI_RESPONSES_COMPAT },
		};
	}
	if (minor !== undefined && minor >= 6 && model.api === "openai-completions") {
		return {
			...model,
			thinkingLevelMap: { ...current.thinkingLevelMap, ...XAI_GROK46_THINKING_LEVEL_MAP },
			compat: { ...current.compat, supportsReasoningEffort: true },
		};
	}
	if (minor === 5) {
		return {
			...model,
			thinkingLevelMap: { ...current.thinkingLevelMap, ...XAI_GROK45_THINKING_LEVEL_MAP },
		};
	}
	return model;
}
