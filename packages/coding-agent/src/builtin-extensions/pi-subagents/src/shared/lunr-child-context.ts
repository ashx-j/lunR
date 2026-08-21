/**
 * lunr: advertised subagents always start with a fresh session.
 * Fork-context internals (`fork-context.ts`, executor usesFork path) stay in
 * the tree for upstream sync; they are not reachable from the model, slash
 * `--fork`, or agent `defaultContext: fork` frontmatter.
 */

export type LunrChildContext = "fresh";

/** Coerce any requested/defaulted context to fresh. */
export function lunrChildContext(_requested?: string): LunrChildContext {
	return "fresh";
}

/** List/get view: never advertise fork, even when on-disk frontmatter says fork. */
export function advertisedDefaultContext(_stored?: string): LunrChildContext {
	return "fresh";
}

export function lunrContextPolicy<T extends { context?: string }>(params: T): {
	params: T & { context: LunrChildContext };
	contextForAgent: (agentName: string) => LunrChildContext;
	usesFork: false;
} {
	return {
		params: { ...params, context: "fresh" },
		contextForAgent: () => "fresh",
		usesFork: false,
	};
}
