/**
 * OpenAI GPT-5+ thinking overlays.
 * Used by generate-models.ts and catalog merge. Do not hand-edit catalog JSON for these maps.
 *
 * Version floors, not frozen ids:
 * - gpt-5.2+ / gpt-6+: native xhigh
 * - gpt-5.6+ / gpt-6+: native max
 * - gpt-6+: off and minimal unsupported (low / medium / high / xhigh / max)
 */
export function canonicalOpenAiModelId(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

export function parseOpenAiGptVersion(modelId: string): { major: number; minor: number } | undefined {
	const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(canonicalOpenAiModelId(modelId));
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

export function supportsOpenAiXhigh(modelId: string): boolean {
	const version = parseOpenAiGptVersion(modelId);
	if (!version) return false;
	return version.major > 5 || (version.major === 5 && version.minor >= 2);
}

export function supportsOpenAiMax(modelId: string): boolean {
	const version = parseOpenAiGptVersion(modelId);
	if (!version) return false;
	return version.major > 5 || (version.major === 5 && version.minor >= 6);
}

export function isOpenAiChatModel(modelId: string): boolean {
	return /(?:^|\/)gpt-\d+(?:\.\d+)?-chat(?:-|$)/i.test(modelId);
}

/** gpt-6+: cannot disable thinking; no minimal; native xhigh and max. */
export const OPENAI_GPT6_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	xhigh: "xhigh",
	max: "max",
} as const;

const OPENAI_EFFORT_PROVIDER_IDS = new Set(["openai", "openai-codex", "azure-openai-responses"]);

type OpenAiOverlayModel = {
	id: string;
	provider?: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: object;
};

/**
 * Stamp GPT-5.2+ / GPT-6+ effort maps onto any catalog layer so a stale shard
 * or live /models row cannot hide xhigh/max or leave gpt-6 on a gpt-4 template.
 */
export function withOpenAiEffortMetadata<T extends { id: string; provider?: string; api?: string }>(model: T): T {
	if (!model.provider || !OPENAI_EFFORT_PROVIDER_IDS.has(model.provider)) return model;
	const version = parseOpenAiGptVersion(model.id);
	if (!version || version.major < 5) return model;

	const current = model as T & OpenAiOverlayModel;
	const thinkingLevelMap: Record<string, string | null> = {
		...(current.thinkingLevelMap as Record<string, string | null> | undefined),
	};
	let changed = false;

	if (supportsOpenAiXhigh(model.id) && thinkingLevelMap.xhigh !== "xhigh") {
		thinkingLevelMap.xhigh = "xhigh";
		changed = true;
	}
	if (supportsOpenAiMax(model.id) && thinkingLevelMap.max !== "max") {
		thinkingLevelMap.max = "max";
		changed = true;
	}
	if (version.major >= 6) {
		for (const [key, value] of Object.entries(OPENAI_GPT6_THINKING_LEVEL_MAP)) {
			if (thinkingLevelMap[key] !== value) {
				thinkingLevelMap[key] = value;
				changed = true;
			}
		}
		if (current.reasoning !== true && !isOpenAiChatModel(model.id)) {
			return { ...model, reasoning: true, thinkingLevelMap };
		}
	}

	if (!changed) return model;
	return { ...model, thinkingLevelMap };
}
