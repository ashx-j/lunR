/**
 * xAI Grok 4.x thinking overlays.
 * Used by generate-models.ts. Do not hand-edit catalog JSON for these maps.
 *
 * Docs (https://docs.x.ai/developers/model-capabilities/text/reasoning):
 * - grok-4.5: low / medium / high (cannot disable). xhigh is treated as high.
 * - grok-4.6+: low / medium / high / xhigh (cannot disable).
 */
export function parseXaiGrok4Minor(modelId: string): number | undefined {
	const match = /^grok-(\d+)\.(\d+)/i.exec(modelId);
	if (!match) return undefined;
	if (Number(match[1]) !== 4) return undefined;
	return Number(match[2]);
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

type XaiEffortModel = {
	id: string;
	provider?: string;
	api?: string;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
};

/** Stamp Grok 4.x effort maps onto any catalog layer so a stale shard cannot hide xhigh. */
export function withXaiEffortMetadata<T extends XaiEffortModel>(model: T): T {
	if (model.provider !== "xai") return model;
	const minor = parseXaiGrok4Minor(model.id);
	if (minor === 5) {
		return {
			...model,
			thinkingLevelMap: { ...model.thinkingLevelMap, ...XAI_GROK45_THINKING_LEVEL_MAP },
		};
	}
	if (minor !== undefined && minor >= 6) {
		const next = {
			...model,
			thinkingLevelMap: { ...model.thinkingLevelMap, ...XAI_GROK46_THINKING_LEVEL_MAP },
		};
		if (model.api === "openai-completions") {
			return {
				...next,
				compat: { ...model.compat, supportsReasoningEffort: true },
			};
		}
		return next;
	}
	return model;
}
