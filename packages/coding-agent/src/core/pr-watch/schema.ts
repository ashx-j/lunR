import { type Static, Type } from "@sinclair/typebox";

export const PR_WATCH_DESCRIPTION = `Watch a GitHub pull request in this owning session. Client polls every 60 seconds without model calls when nothing meaningful changes. The watcher reports facts; verify external feedback against source and decide what needs repair. Arrival timestamps do not associate feedback with the latest commit. Prior-head reviews and inline comments are labeled separately; conversation comments have no supplied commit association.

start: pass a GitHub PR URL. Returns immediately by default; wait:true waits for the first meaningful update. Duplicate starts reuse the original watch and deadline, including completed watches. The duration comes only from the user's PR watch duration setting. Only a different head commit resets that original duration. Green CI, a review, and completing your work do not stop monitoring.

wait: pass the existing watch ID to receive undelivered events or wait for meaningful updates, monitoring completion, or interruption. Normal user input can interrupt waiting while monitoring continues. For normal interactive watching, yield and let lunR wake this session; a busy session receives a follow-up. All delivery channels share one queue.

Monitoring ends at its finite deadline, PR merge/closure, or user cancellation through /pr-watch. It never means the PR is ready. There are no agent stop, restart, extend, status, or duration actions. Do not circumvent the user's configured limit by restarting, launching another session, or writing watcher state/settings.`;

// Keep the provider-facing root an object, as with the other builtin tools.
export const PrWatchParams = Type.Object(
	{
		action: Type.Union([Type.Literal("start"), Type.Literal("wait")]),
		url: Type.Optional(
			Type.String({ description: "Required for start only: https://github.com/OWNER/REPO/pull/NUMBER" }),
		),
		id: Type.Optional(
			Type.String({ description: "Required for wait only: exact watch ID returned by start in this session." }),
		),
		wait: Type.Optional(
			Type.Boolean({
				description: "For start only: wait for the first meaningful event instead of returning immediately.",
			}),
		),
	},
	{ additionalProperties: false },
);

type PrWatchRequest = { action: "start"; url: string; wait?: boolean } | { action: "wait"; id: string };

/** Enforce action-specific fields before anything can start or wait on monitoring. */
export function parsePrWatchRequest(params: Static<typeof PrWatchParams>): PrWatchRequest {
	if (params.action === "start") {
		if (!params.url || params.id !== undefined)
			throw new Error("pr_watch start requires url, with optional wait only.");
		return { action: "start", url: params.url, wait: params.wait };
	}
	if (!params.id || params.url !== undefined || params.wait !== undefined)
		throw new Error("pr_watch wait requires id only.");
	return { action: "wait", id: params.id };
}
