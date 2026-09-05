/**
 * lunR: reusable swarm prompt builder.
 *
 * Moved out of interactive-mode so the gateway can decompose tasks across
 * parallel subagents the same way the TUI does.
 */

export function buildSwarmPrompt(task: string): string {
	return `[SWARM MODE] Task: ${task}
Act as an orchestrator. 1) Decompose into 3-8 independent subtasks. 2) Launch them
in ONE parallel subagent call (async:false) as generic children, each with task,
description, tier ("light", "standard", or "heavy"), and permissions ("full" or
"read-only"; omit permissions for full).
Use read-only children for inspection/review and full children only when edits
are required. Pick a model tier per subtask. 3) Synthesize the results and report.
Rules: max 8 concurrent children; no nested fan-out; if a subtask fails, retry
once with the heavy tier before giving up on it; keep your final report under
100 lines with per-subtask status.`;
}

interface BranchEntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
			.map((c) => String((c as { text?: unknown }).text ?? ""))
			.join("");
	}
	return "";
}

/**
 * True when the current turn started from an explicit /swarm prompt (the most
 * recent user message carries the literal `[SWARM MODE]` prefix). Both the TUI
 * and the gateway inject the same buildSwarmPrompt text, so this works on both
 * surfaces without extra state.
 */
export function isExplicitSwarmTurn(branch: readonly BranchEntryLike[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		return messageText(entry.message.content).startsWith("[SWARM MODE]");
	}
	return false;
}
