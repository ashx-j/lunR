/**
 * lunr: multi-subscription API-key pools per provider.
 *
 * The pool lives in subscriptions.json next to auth.json; auth.json always
 * holds the ACTIVE credential, so rotation is just mirroring the chosen pool
 * key into auth.json via AuthStorage.modify. Persistence reuses the
 * AuthStorage backend classes (proper-lockfile guarded read-modify-write,
 * mode 0600) pointed at the subscriptions.json path.
 *
 * Raw keys are never logged or embedded in error messages — errors refer to
 * provider and key ids only.
 */

import { createHash } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "./auth-storage.ts";
import { parseResetTimeMs } from "./usage-limit.ts";
import { clearPlanUsageCache } from "./usage-service.ts";

export interface SubEntry {
	id: string;
	name: string;
	key: string;
	addedAt: number;
	exhaustedUntil?: number;
	lastError?: string;
}

interface ProviderPool {
	active: string;
	keys: SubEntry[];
}

type SubscriptionData = Record<string, ProviderPool>;

export interface RequestSubscriptionKey {
	providerId: string;
	fingerprint: string;
}

/** Request identities are non-secret digests kept outside messages and storage. */
export function subscriptionKeyFingerprint(providerId: string, key: string): string {
	return createHash("sha256").update(providerId).update("\0").update(key).digest("hex");
}

export class SubscriptionManager {
	private data: SubscriptionData = {};
	private storage: AuthStorageBackend;
	private authStorage: CredentialStore;
	// In-process write queue so mutations serialize even before the file lock.
	private queue: Promise<unknown> = Promise.resolve();
	// Per-provider fingerprints exhausted without a parseable reset time.
	// Process-local on purpose: infinite exhaustion is never persisted.
	private memoryExhausted = new Map<string, Set<string>>();

	private constructor(authStorage: CredentialStore, storage: AuthStorageBackend) {
		this.authStorage = authStorage;
		this.storage = storage;
	}

	static create(authStorage: CredentialStore, path?: string): SubscriptionManager {
		return new SubscriptionManager(
			authStorage,
			new FileAuthStorageBackend(path ?? join(getAgentDir(), "subscriptions.json")),
		);
	}

	static fromStorage(authStorage: CredentialStore, storage: AuthStorageBackend): SubscriptionManager {
		return new SubscriptionManager(authStorage, storage);
	}

	static inMemory(authStorage: CredentialStore, data: SubscriptionData = {}): SubscriptionManager {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return SubscriptionManager.fromStorage(authStorage, storage);
	}

	private parseStorageData(content: string | undefined): SubscriptionData {
		if (content === undefined) return {};
		try {
			const parsed: unknown = JSON.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			for (const value of Object.values(parsed as Record<string, unknown>)) {
				if (!value || typeof value !== "object") throw new Error();
				const pool = value as Record<string, unknown>;
				if (typeof pool.active !== "string" || !Array.isArray(pool.keys)) throw new Error();
				const ids = new Set<string>();
				for (const value of pool.keys as unknown[]) {
					if (!value || typeof value !== "object") throw new Error();
					const entry = value as Record<string, unknown>;
					if (
						typeof entry.id !== "string" ||
						ids.has(entry.id) ||
						typeof entry.name !== "string" ||
						typeof entry.key !== "string" ||
						typeof entry.addedAt !== "number" ||
						!Number.isFinite(entry.addedAt) ||
						(entry.exhaustedUntil !== undefined &&
							(typeof entry.exhaustedUntil !== "number" || !Number.isFinite(entry.exhaustedUntil))) ||
						(entry.lastError !== undefined && typeof entry.lastError !== "string")
					)
						throw new Error();
					ids.add(entry.id);
				}
				if (!ids.has(pool.active)) throw new Error();
			}
			return parsed as SubscriptionData;
		} catch {
			throw new Error("Subscription storage is malformed. Repair it before changing subscriptions.");
		}
	}

	/**
	 * Lock order is subscriptions then auth. Keep selection and its auth mirror
	 * under the subscription lock so later selectors cannot overtake a mirror.
	 * These files are not an atomic commit: a failed mirror aborts the pool write;
	 * a later pool write failure can leave auth ahead and a repeated selection repairs it.
	 */
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(() =>
			this.storage.withLockAsync(async (current) => {
				this.data = this.parseStorageData(current);
				const before = JSON.stringify(this.data, null, 2);
				const result = await fn();
				const after = JSON.stringify(this.data, null, 2);
				return { result, next: before === after ? undefined : after };
			}),
		);
		this.queue = next.catch(() => {});
		return next;
	}

	/** Raw stored credential read via the modify path (returning undefined leaves it unchanged). */
	private async readRawCredential(providerId: string): Promise<Credential | undefined> {
		let current: Credential | undefined;
		await this.authStorage.modify(providerId, async (credential) => {
			current = credential;
			return undefined;
		});
		return current;
	}

	/**
	 * Pool for a provider, lazy-importing an existing stored api_key credential
	 * as "Sub 1" on first access. OAuth credentials are not imported.
	 */
	private async ensurePool(providerId: string): Promise<ProviderPool | undefined> {
		const existing = this.data[providerId];
		if (existing) return existing;

		const credential = await this.readRawCredential(providerId);
		if (credential?.type !== "api_key" || credential.key === undefined) return undefined;

		const pool: ProviderPool = {
			active: "1",
			keys: [{ id: "1", name: "Sub 1", key: credential.key, addedAt: Date.now() }],
		};
		this.data = { ...this.data, [providerId]: pool };
		return pool;
	}

	private nextId(pool: ProviderPool): string {
		let max = 0;
		for (const entry of pool.keys) {
			const numeric = Number.parseInt(entry.id, 10);
			if (Number.isFinite(numeric) && numeric > max) max = numeric;
		}
		return String(max + 1);
	}

	private async mirrorActive(providerId: string, key: string): Promise<void> {
		clearPlanUsageCache();
		try {
			await this.authStorage.modify(providerId, async (current) => ({
				type: "api_key",
				key,
				...(current?.type === "api_key" && current.env ? { env: current.env } : {}),
			}));
		} finally {
			clearPlanUsageCache();
		}
	}

	async list(providerId: string): Promise<SubEntry[]> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			return pool ? [...pool.keys] : [];
		});
	}

	async getActive(providerId: string): Promise<SubEntry | undefined> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			return pool?.keys.find((entry) => entry.id === pool.active);
		});
	}

	async addKey(providerId: string, key: string, name?: string): Promise<SubEntry> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			const id = pool ? this.nextId(pool) : "1";
			const entry: SubEntry = { id, name: name ?? `Sub ${id}`, key, addedAt: Date.now() };
			const keys = [...(pool?.keys ?? []), entry];
			this.data = { ...this.data, [providerId]: { active: id, keys } };
			await this.mirrorActive(providerId, key);
			return entry;
		});
	}

	async removeKey(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool || !pool.keys.some((entry) => entry.id === id)) return;

			const keys = pool.keys.filter((entry) => entry.id !== id);
			const removed = pool.keys.find((entry) => entry.id === id)!;
			if (!keys.some((entry) => entry.key === removed.key)) {
				this.memoryExhausted.get(providerId)?.delete(subscriptionKeyFingerprint(providerId, removed.key));
			}

			if (keys.length === 0) {
				const data = { ...this.data };
				delete data[providerId];
				this.data = data;
				clearPlanUsageCache();
				try {
					await this.authStorage.delete(providerId);
				} finally {
					clearPlanUsageCache();
				}
				return;
			}

			let active = pool.active;
			if (active === id) {
				active = keys[0]?.id ?? active;
				this.data = { ...this.data, [providerId]: { active, keys } };
				const promoted = keys.find((entry) => entry.id === active);
				if (promoted) await this.mirrorActive(providerId, promoted.key);
				return;
			}

			this.data = { ...this.data, [providerId]: { active, keys } };
		});
	}

	async renameKey(providerId: string, id: string, name: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool) return;
			const keys = pool.keys.map((entry) => (entry.id === id ? { ...entry, name } : entry));
			this.data = { ...this.data, [providerId]: { ...pool, keys } };
		});
	}

	async setActive(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			const entry = pool?.keys.find((candidate) => candidate.id === id);
			if (!pool || !entry) return;
			this.data = { ...this.data, [providerId]: { ...pool, active: id } };
			await this.mirrorActive(providerId, entry.key);
		});
	}

	/**
	 * Mark the request's key exhausted and rotate to the next non-exhausted key in
	 * round-robin order. A parseable reset time is persisted as exhaustedUntil;
	 * otherwise the exhaustion is process-local only. A later selection is preserved.
	 * Returns the usable active key for retry, or null when no alternative exists.
	 */
	async rotateOnFailure(
		providerId: string,
		errorMessage: string,
		requestFingerprint: string | undefined,
		now: number = Date.now(),
	): Promise<SubEntry | null> {
		if (!requestFingerprint) return null;
		return this.enqueue(async () => {
			const pool = this.data[providerId];
			if (!pool || pool.keys.length < 2) return null;
			const currentIndex = pool.keys.findIndex((entry) => entry.id === pool.active);
			if (currentIndex === -1) return null;
			const current = pool.keys[currentIndex];
			const matchesRequest = (entry: SubEntry): boolean =>
				subscriptionKeyFingerprint(providerId, entry.key) === requestFingerprint;
			if (!current || !pool.keys.some(matchesRequest)) return null;

			const resetAt = parseResetTimeMs(errorMessage);
			let keys = pool.keys;
			if (resetAt !== undefined && resetAt > now) {
				keys = pool.keys.map((entry) =>
					matchesRequest(entry) ? { ...entry, exhaustedUntil: resetAt, lastError: errorMessage } : entry,
				);
			} else {
				const set = this.memoryExhausted.get(providerId) ?? new Set<string>();
				set.add(requestFingerprint);
				this.memoryExhausted.set(providerId, set);
			}

			const isExhausted = (entry: SubEntry): boolean =>
				this.memoryExhausted.get(providerId)?.has(subscriptionKeyFingerprint(providerId, entry.key)) === true ||
				(entry.exhaustedUntil !== undefined && entry.exhaustedUntil > now);

			if (keys !== pool.keys) this.data = { ...this.data, [providerId]: { ...pool, keys } };
			// Another owner already selected a different credential. Retry it without
			// replacing its selection or mirroring a stale failure over its auth.
			if (!matchesRequest(current)) return isExhausted(current) ? null : current;

			for (let offset = 1; offset < keys.length; offset++) {
				const candidate = keys[(currentIndex + offset) % keys.length];
				if (!candidate || isExhausted(candidate)) continue;
				this.data = { ...this.data, [providerId]: { active: candidate.id, keys } };
				await this.mirrorActive(providerId, candidate.key);
				return candidate;
			}

			// No alternative: keep the now-exhausted current key active.
			return null;
		});
	}

	/** Manual reactivate: clears persisted and process-local exhaustion for a key. */
	async clearExhaustion(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool) return;
			const target = pool.keys.find((entry) => entry.id === id);
			if (target) this.memoryExhausted.get(providerId)?.delete(subscriptionKeyFingerprint(providerId, target.key));
			if (!target || (target.exhaustedUntil === undefined && target.lastError === undefined)) return;
			const keys = pool.keys.map((entry) => {
				if (entry.id !== id) return entry;
				const { exhaustedUntil: _exhaustedUntil, lastError: _lastError, ...rest } = entry;
				return rest;
			});
			this.data = { ...this.data, [providerId]: { ...pool, keys } };
		});
	}
}
