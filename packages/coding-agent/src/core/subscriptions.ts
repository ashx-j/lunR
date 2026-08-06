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

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "./auth-storage.ts";
import { parseResetTimeMs } from "./usage-limit.ts";

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

export class SubscriptionManager {
	private data: SubscriptionData = {};
	private loaded = false;
	private storage: AuthStorageBackend;
	private authStorage: CredentialStore;
	// In-process write queue so mutations serialize even before the file lock.
	private queue: Promise<unknown> = Promise.resolve();
	// Per-provider ids of keys exhausted without a parseable reset time.
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
		if (!content) {
			return {};
		}
		return JSON.parse(content) as SubscriptionData;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
		} catch {
			// Preserve the empty snapshot; a malformed file is never overwritten by a load.
		}
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn);
		this.queue = next.catch(() => {});
		return next;
	}

	private persist(): Promise<void> {
		return this.storage.withLockAsync(async () => ({
			result: undefined,
			next: JSON.stringify(this.data, null, 2),
		}));
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
		this.ensureLoaded();
		const existing = this.data[providerId];
		if (existing) return existing;

		const credential = await this.readRawCredential(providerId);
		if (credential?.type !== "api_key" || credential.key === undefined) return undefined;

		const pool: ProviderPool = {
			active: "1",
			keys: [{ id: "1", name: "Sub 1", key: credential.key, addedAt: Date.now() }],
		};
		this.data = { ...this.data, [providerId]: pool };
		await this.persist();
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
		await this.authStorage.modify(providerId, async () => ({ type: "api_key", key }));
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
			this.ensureLoaded();
			const pool = await this.ensurePool(providerId);
			const id = pool ? this.nextId(pool) : "1";
			const entry: SubEntry = { id, name: name ?? `Sub ${id}`, key, addedAt: Date.now() };
			const keys = [...(pool?.keys ?? []), entry];
			this.data = { ...this.data, [providerId]: { active: id, keys } };
			await this.persist();
			await this.mirrorActive(providerId, key);
			return entry;
		});
	}

	async removeKey(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool || !pool.keys.some((entry) => entry.id === id)) return;

			const keys = pool.keys.filter((entry) => entry.id !== id);
			this.memoryExhausted.get(providerId)?.delete(id);

			if (keys.length === 0) {
				const data = { ...this.data };
				delete data[providerId];
				this.data = data;
				await this.persist();
				await this.authStorage.delete(providerId);
				return;
			}

			let active = pool.active;
			if (active === id) {
				active = keys[0]?.id ?? active;
				this.data = { ...this.data, [providerId]: { active, keys } };
				await this.persist();
				const promoted = keys.find((entry) => entry.id === active);
				if (promoted) await this.mirrorActive(providerId, promoted.key);
				return;
			}

			this.data = { ...this.data, [providerId]: { active, keys } };
			await this.persist();
		});
	}

	async renameKey(providerId: string, id: string, name: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool) return;
			const keys = pool.keys.map((entry) => (entry.id === id ? { ...entry, name } : entry));
			this.data = { ...this.data, [providerId]: { ...pool, keys } };
			await this.persist();
		});
	}

	async setActive(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			const entry = pool?.keys.find((candidate) => candidate.id === id);
			if (!pool || !entry) return;
			this.data = { ...this.data, [providerId]: { ...pool, active: id } };
			await this.persist();
			await this.mirrorActive(providerId, entry.key);
		});
	}

	/**
	 * Mark the active key exhausted and rotate to the next non-exhausted key in
	 * round-robin order. A parseable reset time is persisted as exhaustedUntil;
	 * otherwise the exhaustion is process-local only. Returns the new active key,
	 * or null when no non-exhausted alternative exists (current key stays active).
	 */
	async rotateOnFailure(providerId: string, errorMessage: string, now: number = Date.now()): Promise<SubEntry | null> {
		return this.enqueue(async () => {
			const pool = await this.ensurePool(providerId);
			if (!pool) return null;
			const currentIndex = pool.keys.findIndex((entry) => entry.id === pool.active);
			if (currentIndex === -1) return null;
			const current = pool.keys[currentIndex];
			if (!current) return null;

			const resetAt = parseResetTimeMs(errorMessage);
			let keys = pool.keys;
			if (resetAt !== undefined && resetAt > now) {
				keys = pool.keys.map((entry) =>
					entry.id === current.id ? { ...entry, exhaustedUntil: resetAt, lastError: errorMessage } : entry,
				);
			} else {
				const set = this.memoryExhausted.get(providerId) ?? new Set<string>();
				set.add(current.id);
				this.memoryExhausted.set(providerId, set);
			}

			const isExhausted = (entry: SubEntry): boolean =>
				this.memoryExhausted.get(providerId)?.has(entry.id) === true ||
				(entry.exhaustedUntil !== undefined && entry.exhaustedUntil > now);

			for (let offset = 1; offset < keys.length; offset++) {
				const candidate = keys[(currentIndex + offset) % keys.length];
				if (!candidate || isExhausted(candidate)) continue;
				this.data = { ...this.data, [providerId]: { active: candidate.id, keys } };
				await this.persist();
				await this.mirrorActive(providerId, candidate.key);
				return candidate;
			}

			// No alternative: keep the (now-exhausted) current key active, but still
			// persist its exhaustion state when a reset time was recorded.
			if (keys !== pool.keys) {
				this.data = { ...this.data, [providerId]: { ...pool, keys } };
				await this.persist();
			}
			return null;
		});
	}

	/** Manual reactivate: clears persisted and process-local exhaustion for a key. */
	async clearExhaustion(providerId: string, id: string): Promise<void> {
		return this.enqueue(async () => {
			this.memoryExhausted.get(providerId)?.delete(id);
			const pool = await this.ensurePool(providerId);
			if (!pool) return;
			const target = pool.keys.find((entry) => entry.id === id);
			if (!target || (target.exhaustedUntil === undefined && target.lastError === undefined)) return;
			const keys = pool.keys.map((entry) => {
				if (entry.id !== id) return entry;
				const { exhaustedUntil: _exhaustedUntil, lastError: _lastError, ...rest } = entry;
				return rest;
			});
			this.data = { ...this.data, [providerId]: { ...pool, keys } };
			await this.persist();
		});
	}
}
