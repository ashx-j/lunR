/** Number of children above which aggregate launch confirmation engages. */
export const LARGE_SUBAGENT_LAUNCH_THRESHOLD = 2;

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

export function effectiveLargeSubagentLaunchCount(args: Record<string, unknown>): number {
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

export function effectiveLargeSubagentLaunchCountForTurn(
	args: Record<string, unknown>,
	assistantMessage?: AssistantMessageLike,
): number {
	const own = effectiveLargeSubagentLaunchCount(args);
	const siblingSingles = (assistantMessage?.content ?? []).reduce((total, block) => {
		if (block.type !== "toolCall" || block.name !== "subagent") return total;
		const siblingArgs =
			block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: undefined;
		return siblingArgs ? total + siblingSingleCount(siblingArgs) : total;
	}, 0);
	return Math.max(own, siblingSingles);
}
