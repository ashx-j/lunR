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
