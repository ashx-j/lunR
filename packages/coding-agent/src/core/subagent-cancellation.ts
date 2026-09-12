export interface SubagentCancellation {
	hasActiveRuns(): boolean;
	stop(): Promise<{ requested: number; failed: number }>;
}

const key = Symbol.for("@lunr/subagent-cancellation");
const store = globalThis as typeof globalThis & { [key]?: Map<string, SubagentCancellation> };
const handlers = store[key] ?? new Map<string, SubagentCancellation>();
store[key] = handlers;

export function registerSubagentCancellation(sessionId: string, handler: SubagentCancellation): () => void {
	handlers.set(sessionId, handler);
	return () => {
		if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
	};
}

export function getSubagentCancellation(sessionId: string): SubagentCancellation | undefined {
	return handlers.get(sessionId);
}

export function createSubagentCancellation(options: {
	pendingLaunches: ReadonlySet<Promise<void>>;
	getActiveRunIds(): string[];
	isCurrent(): boolean;
	stopRun(id: string): Promise<boolean>;
}): SubagentCancellation {
	let stopping: Promise<{ requested: number; failed: number }> | undefined;
	return {
		hasActiveRuns: () =>
			options.isCurrent() && (options.pendingLaunches.size > 0 || options.getActiveRunIds().length > 0),
		stop() {
			if (stopping) return stopping;
			stopping = (async () => {
				await Promise.allSettled([...options.pendingLaunches]);
				if (!options.isCurrent()) return { requested: 0, failed: 0 };
				const results = await Promise.allSettled(options.getActiveRunIds().map((id) => options.stopRun(id)));
				return {
					requested: results.filter((result) => result.status === "fulfilled" && result.value).length,
					failed: results.filter((result) => result.status === "rejected" || !result.value).length,
				};
			})().finally(() => {
				stopping = undefined;
			});
			return stopping;
		},
	};
}

export class SubagentEscapeSequence {
	private sessionId: string | undefined;
	private firstPress: number | undefined;

	press(sessionId: string, active: boolean, now = Date.now()): "parent" | "children" | undefined {
		if (!active) {
			this.firstPress = undefined;
			this.sessionId = undefined;
			return undefined;
		}
		const second = this.sessionId === sessionId && this.firstPress !== undefined && now - this.firstPress < 500;
		this.sessionId = sessionId;
		this.firstPress = second ? undefined : now;
		return second ? "children" : "parent";
	}
}
