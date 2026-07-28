/**
 * lunR: gateway pairing (port of hermes-agent's pairing, self-contained).
 *
 * Unauthorized DM users get a short code; the owner approves it out-of-band
 * (`lunr gateway pair approve <platform> <code>`), which pairs that user.
 * Pending codes + approved users persist in <agentDir>/pairing/store.json
 * (chmod 0600 best-effort).
 *
 * Guards: 1h code TTL, max 3 pending codes per platform, 10-min per-user
 * issue rate limit, and a lockout — after 5 failed approve attempts a
 * pending code is invalidated. All limits are injectable for tests.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/** Unambiguous alphabet: no 0/O/1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING = 3;
const DEFAULT_MAX_FAILS = 5;

interface PendingCode {
	code: string;
	platform: string;
	userId: string;
	issuedAt: number;
	fails: number;
}

interface ApprovedUser {
	platform: string;
	userId: string;
	approvedAt: number;
}

interface PairingData {
	pending: PendingCode[];
	approved: ApprovedUser[];
}

export interface PairingOptions {
	/** Directory holding store.json. Default: <agentDir>/pairing. */
	dir?: string;
	ttlMs?: number;
	rateLimitMs?: number;
	maxPending?: number;
	maxFails?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

export interface PairingStore {
	/** Issue a new code; null when the user is rate-limited or the platform's pending list is full. */
	issueCode(platform: string, userId: string): string | null;
	/** Approve a code; returns the paired userId, or null on miss/expiry/lockout. */
	approve(platform: string, code: string): string | null;
	isPaired(platform: string, userId: string): boolean;
	listPending(): Array<{ code: string; platform: string; userId: string; expiresAt: number }>;
	listApproved(): Array<{ platform: string; userId: string; approvedAt: number }>;
}

function normalizeCode(code: string): string {
	return code.replace(/-/g, "").trim().toUpperCase();
}

function generateCode(): string {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
	}
	return code;
}

export function createPairingStore(options: PairingOptions = {}): PairingStore {
	const dir = options.dir ?? join(getAgentDir(), "pairing");
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
	const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
	const maxFails = options.maxFails ?? DEFAULT_MAX_FAILS;
	const now = options.now ?? (() => Date.now());

	function storeFile(): string {
		return join(dir, "store.json");
	}

	function read(): PairingData {
		const path = storeFile();
		if (!existsSync(path)) return { pending: [], approved: [] };
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { pending: [], approved: [] };
			}
			const p = parsed as Record<string, unknown>;
			const pending = Array.isArray(p.pending) ? (p.pending as PendingCode[]) : [];
			const approved = Array.isArray(p.approved) ? (p.approved as ApprovedUser[]) : [];
			return {
				pending: pending.filter(
					(c) => typeof c?.code === "string" && typeof c?.platform === "string" && typeof c?.userId === "string",
				),
				approved: approved.filter((u) => typeof u?.platform === "string" && typeof u?.userId === "string"),
			};
		} catch {
			return { pending: [], approved: [] }; // corrupt: start empty
		}
	}

	function write(data: PairingData): void {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = storeFile();
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
	}

	function livePending(data: PairingData): PendingCode[] {
		const cutoff = now() - ttlMs;
		return data.pending.filter((c) => c.issuedAt >= cutoff && c.fails < maxFails);
	}

	return {
		issueCode(platform, userId) {
			const data = read();
			// Per-user rate limit: any code (live or expired) issued recently blocks re-issue.
			const lastIssued = data.pending
				.filter((c) => c.platform === platform && c.userId === userId)
				.reduce((max, c) => Math.max(max, c.issuedAt), 0);
			if (lastIssued > 0 && now() - lastIssued < rateLimitMs) return null;
			const live = livePending(data);
			if (live.filter((c) => c.platform === platform).length >= maxPending) return null;
			const entry: PendingCode = {
				code: generateCode(),
				platform,
				userId,
				issuedAt: now(),
				fails: 0,
			};
			data.pending = [...live, entry];
			write(data);
			return entry.code;
		},

		approve(platform, code) {
			const data = read();
			const live = livePending(data);
			const normalized = normalizeCode(code);
			const match = live.find((c) => c.platform === platform && c.code === normalized);
			if (match) {
				data.pending = live.filter((c) => c !== match);
				data.approved = [
					...data.approved.filter((u) => !(u.platform === platform && u.userId === match.userId)),
					{ platform, userId: match.userId, approvedAt: now() },
				];
				write(data);
				return match.userId;
			}
			// Failed attempt: count it against every pending code for this platform;
			// a code that accumulates maxFails misses is invalidated (lockout).
			let changed = false;
			for (const entry of live) {
				if (entry.platform !== platform) continue;
				entry.fails += 1;
				changed = true;
			}
			data.pending = changed ? livePending({ ...data, pending: live }) : live;
			write(data);
			return null;
		},

		isPaired(platform, userId) {
			return read().approved.some((u) => u.platform === platform && u.userId === userId);
		},

		listPending() {
			const data = read();
			return livePending(data).map((c) => ({
				code: c.code,
				platform: c.platform,
				userId: c.userId,
				expiresAt: c.issuedAt + ttlMs,
			}));
		},

		listApproved() {
			return read().approved.map((u) => ({ platform: u.platform, userId: u.userId, approvedAt: u.approvedAt }));
		},
	};
}
