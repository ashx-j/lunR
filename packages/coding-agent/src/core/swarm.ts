/**
 * lunR: reusable swarm prompt builder.
 *
 * Moved out of interactive-mode so the gateway can decompose tasks across
 * parallel subagents the same way the TUI does.
 */

export function buildSwarmPrompt(task: string): string {
	return `[SWARM MODE] Task: ${task}
Act as an orchestrator. 1) Decompose into 3-8 independent subtasks. 2) Launch them
in ONE parallel subagent call (async:false), picking an agent + model tier per
subtask (prefer scout for exploration, worker for implementation, reviewer for
verification). 3) Synthesize the results and report. Rules: max 8 concurrent
subagents; no nested fan-out; if a subtask fails, retry once with the heavy tier
before giving up on it; keep your final report under 100 lines with per-subtask
status.`;
}

/**
 * lunR: agent-swarm auto-activation gate helpers.
 *
 * When the model launches more than SWARM_APPROVAL_THRESHOLD parallel subagents
 * in one `subagent` `tasks`/`chain.parallel` call, or that many same-turn SINGLE
 * `subagent` calls, that counts as an auto-activated agent swarm and requires
 * user approval in every permission mode except `auto` (see core/permissions.ts).
 * An explicit /swarm turn is pre-approved because the user already asked for the swarm.
 */

/** Parallel-subagent count above which the swarm approval gate engages. */
export const SWARM_APPROVAL_THRESHOLD = 2;

function countEntry(item: unknown): number {
	const count = item && typeof item === "object" ? (item as { count?: unknown }).count : undefined;
	return typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : 1;
}

function isManagementCall(args: Record<string, unknown>): boolean {
	return typeof args.action === "string" && args.action.length > 0;
}

function isAsyncDetached(args: Record<string, unknown>): boolean {
	return args.async === true && args.clarify !== true;
}

/**
 * Effective number of parallel subagents a `subagent` tool call will launch:
 * the `tasks` array (with `count` multipliers) plus any `chain` step `parallel`
 * fan-out blocks. Sequential chain steps and single-agent calls count as 0.
 * Dynamic `expand` fan-out has no static count and is not gated.
 */
export function effectiveSwarmCount(args: Record<string, unknown>): number {
	let total = 0;
	if (Array.isArray(args.tasks)) {
		for (const task of args.tasks) total += countEntry(task);
	}
	if (Array.isArray(args.chain)) {
		for (const step of args.chain) {
			const parallel = step && typeof step === "object" ? (step as { parallel?: unknown }).parallel : undefined;
			if (Array.isArray(parallel)) {
				for (const child of parallel) total += countEntry(child);
			}
		}
	}
	return total;
}

function siblingSingleCount(args: Record<string, unknown>): number {
	if (isManagementCall(args) || isAsyncDetached(args)) return 0;
	if (Array.isArray(args.tasks) || Array.isArray(args.chain)) return 0;
	return typeof args.agent === "string" && args.agent.length > 0 ? 1 : 0;
}

interface AssistantMessageLike {
	content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }>;
}

/**
 * Parallel subagent count for the swarm gate. Uses this call's `tasks` / chain
 * `parallel` blocks, plus every other same-turn SINGLE `subagent` call so three
 * sibling singles still trip the >2 approval gate.
 */
export function effectiveSwarmCountForTurn(
	args: Record<string, unknown>,
	assistantMessage?: AssistantMessageLike,
): number {
	const own = effectiveSwarmCount(args);
	const siblingSingles = (assistantMessage?.content ?? []).reduce((total, block) => {
		if (block.type !== "toolCall" || block.name !== "subagent") return total;
		const siblingArgs =
			block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: undefined;
		if (!siblingArgs) return total;
		return total + siblingSingleCount(siblingArgs);
	}, 0);
	return Math.max(own, siblingSingles);
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
