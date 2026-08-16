/**
 * Official Grok CLI SuperGrok session (`~/.grok/auth.json`).
 *
 * lunR and Grok CLI share xAI client `b1a00492-073a-47ea-816f-4c329264a828`.
 * xAI rotates refresh tokens and revokes the family on reuse, so this module
 * must never write a rotated-out refresh back over a newer one.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

export const XAI_PROVIDER_ID = "xai";
/** Same client as packages/ai/src/auth/oauth/xai.ts `XAI_CLIENT_ID`. */
export const XAI_GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** Matches packages/ai/src/auth/oauth/xai.ts `REFRESH_SKEW_MS`. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export function grokHomeDir(grokHome?: string): string {
	if (grokHome) return grokHome;
	const fromEnv = process.env.GROK_HOME?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".grok");
}

export function grokAuthPath(grokHome?: string): string {
	return join(grokHomeDir(grokHome), "auth.json");
}

export function grokOidcEntryKey(clientId: string = XAI_GROK_CLI_CLIENT_ID): string {
	return `https://auth.x.ai::${clientId}`;
}

export function parseGrokExpiresAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) {
			return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
		}
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** Grok CLI deserializes `expires_at` as RFC3339, not epoch ms. */
export function formatGrokExpiresAt(expires: number): string {
	return new Date(expires).toISOString();
}

export function grokEntryToOAuth(entry: unknown): OAuthCredential | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;
	const access = typeof record.key === "string" ? record.key : undefined;
	const refresh = typeof record.refresh_token === "string" ? record.refresh_token : undefined;
	const expires = parseGrokExpiresAt(record.expires_at);
	if (!access || !refresh || expires === undefined) return undefined;
	return { type: "oauth", access, refresh, expires };
}

export function readGrokCliXaiOAuth(options: { grokHome?: string } = {}): OAuthCredential | undefined {
	try {
		const raw = readFileSync(grokAuthPath(options.grokHome), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return grokEntryToOAuth((parsed as Record<string, unknown>)[grokOidcEntryKey()]);
	} catch {
		return undefined;
	}
}

export function hasGrokCliXaiAuth(options: { grokHome?: string } = {}): boolean {
	return readGrokCliXaiOAuth(options) !== undefined;
}

/**
 * Pick the live SuperGrok session.
 *
 * lunR stores `expires` 5 minutes early. Grok CLI stores the server expiry.
 * A raw `>=` compare therefore treats a just-rotated lunR token as older than
 * the still-unrotated Grok file and writes the dead refresh back. When both
 * look live and the refresh tokens differ, keep lunR; `modify` retries Grok
 * only after `invalid_grant`.
 */
export function chooseXaiOAuth(
	lunr: Credential | undefined,
	grok: OAuthCredential | undefined,
): Credential | undefined {
	if (lunr?.type === "api_key") return lunr;
	const lunrOAuth = lunr?.type === "oauth" ? lunr : undefined;
	if (lunrOAuth && grok) {
		if (lunrOAuth.refresh === grok.refresh) {
			return grok.expires >= lunrOAuth.expires ? grok : lunrOAuth;
		}
		const now = Date.now();
		const lunrLive = now < lunrOAuth.expires;
		const grokLive = now < grok.expires;
		if (grokLive && !lunrLive) return grok;
		if (lunrLive && !grokLive) return lunrOAuth;
		if (!lunrLive && !grokLive) return grok.expires >= lunrOAuth.expires ? grok : lunrOAuth;
		return lunrOAuth;
	}
	return grok ?? lunrOAuth ?? lunr;
}

function oauthRefreshFailed(error: unknown): boolean {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(current.message);
			current = current.cause;
			continue;
		}
		break;
	}
	const chain = parts.join(" ");
	if (/timed out|aborted|cancelled|ECONN|ENOTFOUND|network/i.test(chain)) return false;
	return /invalid_grant|refresh token revoked/i.test(chain);
}

function shouldAdopt(lunr: Credential | undefined, chosen: Credential | undefined): boolean {
	if (!chosen || chosen.type !== "oauth") return false;
	if (!lunr || lunr.type !== "oauth") return true;
	return lunr.access !== chosen.access || lunr.refresh !== chosen.refresh;
}

function writeAuthFileAtomic(authPath: string, contents: string): void {
	const tmp = `${authPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, contents, AUTH_FILE_WRITE_OPTIONS);
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// mode bits are best-effort on Windows.
	}
	try {
		if (process.platform === "win32" && existsSync(authPath)) {
			writeFileSync(authPath, contents, AUTH_FILE_WRITE_OPTIONS);
			chmodSync(authPath, 0o600);
			return;
		}
		renameSync(tmp, authPath);
		try {
			chmodSync(authPath, 0o600);
		} catch {
			// mode bits are best-effort on Windows.
		}
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			// tmp already renamed, or never created.
		}
	}
}

function acquireGrokLock(authPath: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(authPath, { realpath: false, stale: 120_000 });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to match AuthStorage.
			}
		}
	}
	throw (lastError as Error) ?? new Error("Failed to acquire Grok CLI auth lock");
}

export function writeGrokCliXaiOAuth(
	credential: OAuthCredential,
	options: { grokHome?: string; onlyIfFileExists?: boolean } = {},
): boolean {
	const authPath = grokAuthPath(options.grokHome);
	if (options.onlyIfFileExists !== false && !existsSync(authPath)) return false;

	const dir = dirname(authPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!existsSync(authPath)) {
		writeAuthFileAtomic(authPath, "{}\n");
	}

	let release: (() => void) | undefined;
	try {
		release = acquireGrokLock(authPath);
		let data: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			} else {
				return false;
			}
		} catch {
			// Never replace a corrupt Grok file with a single-entry stub.
			return false;
		}
		const key = grokOidcEntryKey();
		const previous =
			data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
				? (data[key] as Record<string, unknown>)
				: {};
		const existing = grokEntryToOAuth(previous);
		if (
			existing &&
			existing.refresh !== credential.refresh &&
			existing.expires > credential.expires + REFRESH_SKEW_MS
		) {
			// Disk already has a newer family (usually a later `grok login`).
			return false;
		}
		data[key] = {
			...previous,
			key: credential.access,
			refresh_token: credential.refresh,
			expires_at: formatGrokExpiresAt(credential.expires),
		};
		writeAuthFileAtomic(authPath, `${JSON.stringify(data, null, 2)}\n`);
		return true;
	} finally {
		if (release) {
			try {
				release();
			} catch {
				// Unlock is best-effort.
			}
		}
	}
}

export function wrapXaiGrokCliCredentials(
	store: CredentialStore,
	options: { grokHome?: string } = {},
): CredentialStore {
	const grokHome = options.grokHome;
	return {
		async read(providerId: string): Promise<Credential | undefined> {
			const stored = await store.read(providerId);
			if (providerId !== XAI_PROVIDER_ID) return stored;
			if (stored?.type === "api_key") return stored;
			const grok = readGrokCliXaiOAuth({ grokHome });
			const chosen = chooseXaiOAuth(stored, grok);
			if (shouldAdopt(stored, chosen) && chosen?.type === "oauth") {
				try {
					await store.modify(providerId, async (current) => {
						if (current?.type === "api_key") return undefined;
						const latestGrok = readGrokCliXaiOAuth({ grokHome });
						const latestChosen = chooseXaiOAuth(current, latestGrok);
						if (shouldAdopt(current, latestChosen) && latestChosen?.type === "oauth") {
							return latestChosen;
						}
						return undefined;
					});
				} catch {
					// Read still returns the live Grok token if persist fails.
				}
			}
			return chosen;
		},
		async list(): Promise<readonly CredentialInfo[]> {
			const entries = new Map((await store.list()).map((entry) => [entry.providerId, entry]));
			if (!entries.has(XAI_PROVIDER_ID) && hasGrokCliXaiAuth({ grokHome })) {
				entries.set(XAI_PROVIDER_ID, { providerId: XAI_PROVIDER_ID, type: "oauth" });
			}
			return [...entries.values()];
		},
		modify(providerId, fn) {
			if (providerId !== XAI_PROVIDER_ID) return store.modify(providerId, fn);
			return store.modify(providerId, async (lunrCurrent) => {
				if (lunrCurrent?.type === "api_key") return fn(lunrCurrent);
				const grok = readGrokCliXaiOAuth({ grokHome });
				const chosen = chooseXaiOAuth(lunrCurrent, grok);
				let next: Credential | undefined;
				try {
					next = await fn(chosen);
				} catch (error) {
					const retryGrok = readGrokCliXaiOAuth({ grokHome });
					const canRetry =
						oauthRefreshFailed(error) &&
						retryGrok &&
						!(chosen?.type === "oauth" && retryGrok.refresh === chosen.refresh);
					if (!canRetry) throw error;
					try {
						next = await fn(retryGrok);
					} catch {
						throw error;
					}
				}
				// `undefined` means "leave the lunR row unchanged". Adopting `chosen`
				// here wrote a rotated-out Grok refresh over a just-rotated lunR token.
				if (next?.type === "oauth") {
					try {
						writeGrokCliXaiOAuth(next, { grokHome, onlyIfFileExists: true });
					} catch {
						// lunR persist still happens; Grok file update is best-effort.
					}
				}
				return next;
			});
		},
		delete(providerId: string): Promise<void> {
			return store.delete(providerId);
		},
	};
}
