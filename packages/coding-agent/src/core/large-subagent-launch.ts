import { resolveSubagentRequestParams } from "../builtin-extensions/pi-subagents/src/runs/foreground/request-params.ts";

/** Number of children above which aggregate launch confirmation engages. */
export const LARGE_SUBAGENT_LAUNCH_THRESHOLD = 2;

function countEntry(item: unknown): number {
	const count = item && typeof item === "object" ? (item as { count?: unknown }).count : undefined;
	return typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : 1;
}

function isManagementCall(args: Record<string, unknown>): boolean {
	return typeof args.action === "string" && args.action.length > 0;
}

/** Children launched by one call's `tasks` and `chain[].parallel` entries. */
export function effectiveLargeSubagentLaunchCount(input: Record<string, unknown>): number {
	return fanoutCount(resolveSubagentRequestParams(input));
}

function fanoutCount(args: Record<string, unknown>): number {
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

/** Children one sibling call launches: its fanout, or 1 for a single task. Control actions launch none. */
function siblingLaunchCount(input: Record<string, unknown>): number {
	const args = resolveSubagentRequestParams(input);
	if (isManagementCall(args)) return 0;
	if ((Array.isArray(args.tasks) && args.tasks.length > 0) || (Array.isArray(args.chain) && args.chain.length > 0))
		return fanoutCount(args);
	return typeof args.task === "string" &&
		args.task.length > 0 &&
		typeof args.description === "string" &&
		args.description.length > 0
		? 1
		: 0;
}

interface AssistantMessageLike {
	content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }>;
}

/**
 * Children launched by every `subagent` call in the assistant turn, so mixed
 * single and fanout calls add up. Falls back to this call's own fanout when the
 * turn message is missing or does not include it.
 */
export function effectiveLargeSubagentLaunchCountForTurn(
	args: Record<string, unknown>,
	assistantMessage?: AssistantMessageLike,
): number {
	const own = effectiveLargeSubagentLaunchCount(args);
	const turnTotal = (assistantMessage?.content ?? []).reduce((total, block) => {
		if (block.type !== "toolCall" || block.name !== "subagent") return total;
		const siblingArgs =
			block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: undefined;
		return siblingArgs ? total + siblingLaunchCount(siblingArgs) : total;
	}, 0);
	return Math.max(own, turnTotal);
}
