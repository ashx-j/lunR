export const SUBAGENT_WAIT_INTERRUPTION_SYMBOL = Symbol.for("@lunr/subagent-wait-interruption");

export interface SubagentWaitInterruptionRegistration {
	signal: AbortSignal;
	wasInterrupted(): boolean;
	unregister(): void;
}

export interface SubagentWaitInterruptionOwner {
	register(): SubagentWaitInterruptionRegistration;
}

interface SubagentWaitInterruptionBridge {
	owners: Map<string, SubagentWaitInterruptionOwner>;
}

function getBridge(): SubagentWaitInterruptionBridge {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[SUBAGENT_WAIT_INTERRUPTION_SYMBOL] as SubagentWaitInterruptionBridge | undefined;
	if (existing) return existing;
	const bridge: SubagentWaitInterruptionBridge = { owners: new Map() };
	globals[SUBAGENT_WAIT_INTERRUPTION_SYMBOL] = bridge;
	return bridge;
}

export function registerSubagentWaitInterruptionOwner(
	sessionId: string,
	owner: SubagentWaitInterruptionOwner,
): () => void {
	const owners = getBridge().owners;
	owners.set(sessionId, owner);
	return () => {
		if (owners.get(sessionId) === owner) owners.delete(sessionId);
	};
}
