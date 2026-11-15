/**
 * lunR: gateway session store (<agentDir>/gateway-sessions.json).
 *
 * Maps session keys (see session-keys.ts) to the agent session backing each
 * chat conversation, so the agent-bridge can reopen a conversation after a
 * daemon restart. Atomic writes; a missing or corrupt file starts empty.
 * Tests override the file location via setGatewayStorePath().
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { writeJsonFileAtomic } from "../utils/json.ts";

export interface StoredSession {
	sessionId: string;
	sessionFile: string;
	createdAt: string;
	lastActiveAt: string;
}

type StoreData = Record<string, StoredSession>;

let storePathOverride: string | undefined;

/** Test hook: pin the store file location (pass undefined to reset). */
export function setGatewayStorePath(path: string | undefined): void {
	storePathOverride = path;
}

function storePath(): string {
	return storePathOverride ?? join(getAgentDir(), "gateway-sessions.json");
}

function readStore(): StoreData {
	const path = storePath();
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: StoreData = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value == null || typeof value !== "object") continue;
			const v = value as Record<string, unknown>;
			if (typeof v.sessionId !== "string" || typeof v.sessionFile !== "string") continue;
			out[key] = {
				sessionId: v.sessionId,
				sessionFile: v.sessionFile,
				createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString(),
				lastActiveAt: typeof v.lastActiveAt === "string" ? v.lastActiveAt : new Date(0).toISOString(),
			};
		}
		return out;
	} catch {
		return {}; // corrupt file: start empty
	}
}

function writeStore(data: StoreData): void {
	writeJsonFileAtomic(storePath(), data);
}

export function getSession(key: string): StoredSession | undefined {
	return readStore()[key];
}

export function putSession(key: string, entry: { sessionId: string; sessionFile: string }): StoredSession {
	const data = readStore();
	const existing = data[key];
	const stored: StoredSession = {
		sessionId: entry.sessionId,
		sessionFile: entry.sessionFile,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
	};
	data[key] = stored;
	writeStore(data);
	return stored;
}

/** Bump lastActiveAt without replacing the entry. */
export function touchSession(key: string): void {
	const data = readStore();
	const existing = data[key];
	if (!existing) return;
	existing.lastActiveAt = new Date().toISOString();
	writeStore(data);
}

export function removeSession(key: string): boolean {
	const data = readStore();
	if (!(key in data)) return false;
	delete data[key];
	writeStore(data);
	return true;
}

export function listSessions(): StoreData {
	return readStore();
}
