export const SUBAGENT_SPINNER_NAMES = ["braille", "orbit", "snake", "sparkle"] as const;
export type SubagentSpinnerName = (typeof SUBAGENT_SPINNER_NAMES)[number];

export const DEFAULT_SUBAGENT_SPINNER: SubagentSpinnerName = "braille";

export const SUBAGENT_SPINNER_LABELS: Record<SubagentSpinnerName, string> = {
	braille: "Braille",
	orbit: "Orbit",
	snake: "Snake",
	sparkle: "Sparkle",
};

export function isSubagentSpinnerName(value: unknown): value is SubagentSpinnerName {
	return typeof value === "string" && SUBAGENT_SPINNER_NAMES.includes(value as SubagentSpinnerName);
}
