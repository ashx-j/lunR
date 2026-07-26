/**
 * Thinking-level helpers (absorbed from the former ashxj-thinking baked-in
 * extension into core).
 *
 * Holds the 7-level thinking list (lunR adds "max"), per-level descriptions,
 * and the per-model availability filter — aligned with core
 * `getSupportedThinkingLevels()` (packages/ai/src/models.ts): xhigh/max require
 * a DEFINED `thinkingLevelMap` entry, not merely a non-null one, so the picker
 * and completions never offer levels core would clamp away at set time.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** All known levels, in display order. */
const ALL_LEVELS_7: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Default 5 — used when the active model is unknown (xhigh/max support undetermined). */
const ALL_LEVELS_5: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/** Trimmed structural view of a Model — only the fields the filter reads. */
interface ThinkingModelLike {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

/** Returns the levels valid for the given model, in display order. */
export function availableThinkingLevelsFor(model: ThinkingModelLike | undefined): readonly ThinkingLevel[] {
	if (!model) return ALL_LEVELS_5;
	if (model.reasoning === false) return ["off"];
	return ALL_LEVELS_7.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

const VISIBILITY_SUBCOMMANDS: readonly AutocompleteItem[] = [
	{ value: "show", label: "show", description: "Show thinking blocks (persisted)" },
	{ value: "hide", label: "hide", description: "Hide thinking blocks (persisted)" },
	{ value: "toggle", label: "toggle", description: "Toggle thinking blocks (persisted)" },
];

/** Argument completions for /thinking: visibility subcommands first, then the levels valid for the model. */
export function getThinkingArgumentCompletions(
	prefix: string,
	model: ThinkingModelLike | undefined,
): AutocompleteItem[] {
	const lower = prefix.toLowerCase();
	const levelItems = availableThinkingLevelsFor(model)
		.filter((level) => level.startsWith(lower))
		.map((level) => ({ value: level, label: level, description: THINKING_LEVEL_DESCRIPTIONS[level] }));
	return [...VISIBILITY_SUBCOMMANDS.filter((item) => item.value.startsWith(lower)), ...levelItems];
}
