export type SessionResourceCleanup = (sessionId?: string) => void;

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}

const modelSwitchCleanups = new Set<SessionResourceCleanup>();

/** Registers cleanup for resources that hold one model's conversation, such as a Claude Code session process. */
export function registerModelSwitchCleanup(cleanup: SessionResourceCleanup): () => void {
	modelSwitchCleanups.add(cleanup);
	return () => {
		modelSwitchCleanups.delete(cleanup);
	};
}

/** Releases a session's per-model resources after its model changed. */
export function cleanupModelSwitchResources(sessionId: string): void {
	for (const cleanup of modelSwitchCleanups) cleanup(sessionId);
}
