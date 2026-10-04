import { AsyncLocalStorage } from "node:async_hooks";
import { ActivityMonitor, runWithActivity } from "./activity.ts";

type Cleanup = () => void | Promise<void>;

/** Heavy modules acquire resources inside the calling factory's async scope. */
export function createWebSession() {
	return {
		activity: new ActivityMonitor(),
		cleanups: new Set<Cleanup>(),
		closed: false,
	};
}

export type WebSession = ReturnType<typeof createWebSession>;
const sessionScope = new AsyncLocalStorage<WebSession>();
const pendingCleanups = new WeakMap<WebSession, Promise<void>>();

export function getWebSession(): WebSession | undefined {
	return sessionScope.getStore();
}

export function runWithWebSession<T>(session: WebSession, fn: () => T): T {
	return sessionScope.run(session, () => runWithActivity(session.activity, fn));
}

export function runSessionCleanups(session: WebSession): Promise<void> {
	const existing = pendingCleanups.get(session);
	if (existing) return existing;
	session.closed = true;
	const pending = [...session.cleanups].map(async (cleanup) => cleanup());
	session.cleanups.clear();
	const cleanup = Promise.allSettled(pending).then((results) => {
		const errors: unknown[] = [];
		for (const result of results) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		if (errors.length > 0) {
			const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
			throw new AggregateError(errors, `Web session cleanup failed: ${details}`);
		}
	});
	pendingCleanups.set(session, cleanup);
	return cleanup;
}
