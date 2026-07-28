/**
 * lunR: gateway session keys.
 *
 * One agent session per (platform, chat[, thread][, user]) conversation:
 *   agent:main:<platform>:<chatType>:<chatId>[:<threadId>][:<userId>]
 * Thread sessions are shared (no userId — a thread is already a narrow
 * context). Group/channel sessions append the userId when
 * groupSessionsPerUser is on, so each member talks to their own session.
 * Every component is sanitized (`:` and whitespace → `_`) so keys stay
 * single-line and unambiguous.
 */

import type { SessionSource } from "./types.ts";

export const SESSION_KEY_PREFIX = "agent:main";

export interface SessionKeyOptions {
	groupSessionsPerUser: boolean;
}

function sanitize(component: string): string {
	return component.replace(/[\s:]+/g, "_");
}

export function buildSessionKey(source: SessionSource, options: SessionKeyOptions): string {
	const parts = [source.platform, source.chatType, source.chatId].map(sanitize);
	if (source.threadId) {
		parts.push(sanitize(source.threadId));
	} else if ((source.chatType === "group" || source.chatType === "channel") && options.groupSessionsPerUser) {
		parts.push(sanitize(source.userId));
	}
	return [SESSION_KEY_PREFIX, ...parts].join(":");
}
