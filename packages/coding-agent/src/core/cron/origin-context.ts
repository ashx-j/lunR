/**
 * lunR: cron origin context (Phase 4 of the cron/gateway roadmap).
 *
 * AsyncLocalStorage carrying the chat a gateway turn came from. The gateway
 * agent bridge wraps session.prompt() in runWithOrigin(source, ...) so any
 * tool executing during that turn (e.g. the `cron` tool's create action) can
 * stamp jobs with the chat as their delivery origin. AsyncLocalStorage
 * propagates through awaited async calls, so deeply-nested tool execution
 * still sees the origin. Outside a gateway turn currentOrigin() is undefined
 * and behavior is unchanged (jobs default to "local" delivery).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CronOriginContext {
	platform: string;
	chatId: string;
	threadId?: string;
	chatType?: string;
}

const storage = new AsyncLocalStorage<CronOriginContext>();

/** Run fn with `origin` visible to currentOrigin() for the whole async call tree. */
export function runWithOrigin<T>(origin: CronOriginContext, fn: () => T): T {
	return storage.run(origin, fn);
}

/** The origin of the current async context, or undefined outside a gateway turn. */
export function currentOrigin(): CronOriginContext | undefined {
	return storage.getStore();
}
