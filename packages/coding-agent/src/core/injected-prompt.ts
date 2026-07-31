/**
 * lunr: detect injected prompts (/swarm, /research, /goal) so the transcript can
 * render them collapsed instead of dumping the full multi-line prompt verbatim.
 *
 * These prompts become plain {role:"user"} messages (PromptOptions.source is not
 * persisted), so detection is keyed on stable markers that already exist in the
 * prompt bodies: the `[SWARM MODE]` / `[DEEP RESEARCH]` literal prefixes and the
 * goal extension's `<!-- pi-goal-prompt:… -->` HTML comment. This is render-time
 * only — the model still receives the full prompt unchanged, and old session
 * transcripts are cleaned up retroactively with no schema migration.
 */

export type InjectedPromptKind = "swarm" | "research" | "goal";

export interface InjectedPromptInfo {
	kind: InjectedPromptKind;
	/** One-line summary extracted from the prompt body (task / question / objective). */
	summary: string;
}

function firstNonEmptyLine(text: string): string | undefined {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line) return line;
	}
	return undefined;
}

/** Extract the value following a `Label:` prefix on the first line, else undefined. */
function extractAfterLabel(text: string, label: string): string | undefined {
	const idx = text.indexOf(label);
	if (idx === -1) return undefined;
	const rest = text.slice(idx + label.length).split(/\r?\n/)[0] ?? "";
	const trimmed = rest.trim();
	return trimmed || undefined;
}

/** Extract the contents of a `<goal_objective>…</goal_objective>` block. */
function extractGoalObjective(text: string): string | undefined {
	const open = text.indexOf("<goal_objective>");
	if (open === -1) return undefined;
	const close = text.indexOf("</goal_objective>", open);
	if (close === -1) return undefined;
	const inner = text.slice(open + "<goal_objective>".length, close);
	const trimmed = inner.trim();
	// Unescape the minimal XML escaping the goal prompt builder applies.
	return trimmed.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() || undefined;
}

export function detectInjectedPrompt(text: string): InjectedPromptInfo | undefined {
	if (!text) return undefined;

	if (text.startsWith("[SWARM MODE]")) {
		const summary = extractAfterLabel(text, "Task:") ?? firstNonEmptyLine(text.slice("[SWARM MODE]".length).trim());
		return { kind: "swarm", summary: summary ?? "swarm task" };
	}

	if (text.startsWith("[DEEP RESEARCH]")) {
		const summary =
			extractAfterLabel(text, "Question:") ?? firstNonEmptyLine(text.slice("[DEEP RESEARCH]".length).trim());
		return { kind: "research", summary: summary ?? "research question" };
	}

	if (text.includes("pi-goal-prompt:")) {
		const objective = extractGoalObjective(text);
		return { kind: "goal", summary: objective ?? "goal" };
	}

	return undefined;
}

export const INJECTED_PROMPT_LABELS: Record<InjectedPromptKind, string> = {
	swarm: "swarm",
	research: "research",
	goal: "goal",
};
