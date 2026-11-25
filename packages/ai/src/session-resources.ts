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

/** Registers cleanup for resources that hold a copy of a session's conversation, such as a Claude Code session process. */
export function registerConversationCleanup(cleanup: SessionResourceCleanup): () => void {
	conversationCleanups.add(cleanup);
	return () => {
		conversationCleanups.delete(cleanup);
	};
}

/** Releases them after the conversation changed outside a request: a model switch or an aborted run. */
export function cleanupConversationResources(sessionId: string): void {
	for (const cleanup of conversationCleanups) cleanup(sessionId);
}

let interactiveHost = false;

/** Marks this process as an interactive host (the TUI), where a person often returns to an idle session. */
export function setInteractiveHost(value: boolean): void {
	interactiveHost = value;
}

export function isInteractiveHost(): boolean {
	return interactiveHost;
}
