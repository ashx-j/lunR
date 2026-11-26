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

const conversationCleanups = new Set<SessionResourceCleanup>();

/** Registers cleanup for resources prepared for a session's next request, such as a spare Claude Code process. */
export function registerConversationCleanup(cleanup: SessionResourceCleanup): () => void {
	conversationCleanups.add(cleanup);
	return () => {
		conversationCleanups.delete(cleanup);
	};
}

/** Releases them when the next request will not come as prepared: after a model switch or an aborted run. */
export function cleanupConversationResources(sessionId: string): void {
	for (const cleanup of conversationCleanups) cleanup(sessionId);
}
