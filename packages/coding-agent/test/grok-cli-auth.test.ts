import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	chooseXaiOAuth,
	grokAuthPath,
	grokEntryToOAuth,
	grokOidcEntryKey,
	parseGrokExpiresAt,
	readGrokCliXaiOAuth,
	wrapXaiGrokCliCredentials,
	writeGrokCliXaiOAuth,
	XAI_GROK_CLI_CLIENT_ID,
} from "../src/core/grok-cli-auth.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = join(tmpdir(), `lunr-grok-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function grokFile(home: string, entry: Record<string, unknown>): void {
	writeFileSync(grokAuthPath(home), `${JSON.stringify({ [grokOidcEntryKey()]: entry }, null, 2)}\n`, "utf-8");
}

const liveGrok = {
	key: "grok-access",
	refresh_token: "grok-refresh",
	expires_at: Date.now() + 60 * 60 * 1000,
	email: "user@example.com",
	user_id: "user-1",
	auth_mode: "oidc",
};

describe("grok CLI auth parsing", () => {
	it("maps key/refresh_token/expires_at and keeps epoch ms", () => {
		const expires = Date.now() + 120_000;
		expect(grokEntryToOAuth({ key: "a", refresh_token: "r", expires_at: expires })).toEqual({
			type: "oauth",
			access: "a",
			refresh: "r",
			expires,
		});
	});

	it("parses epoch seconds and ISO expires_at", () => {
		expect(parseGrokExpiresAt(1_775_000_000)).toBe(1_775_000_000_000);
		expect(parseGrokExpiresAt("2026-08-21T15:58:10.578Z")).toBe(Date.parse("2026-08-21T15:58:10.578Z"));
	});

	it("uses the official Grok CLI OIDC entry key", () => {
		expect(grokOidcEntryKey()).toBe(`https://auth.x.ai::${XAI_GROK_CLI_CLIENT_ID}`);
	});

	it("prefers the later SuperGrok expiry and never overlays an API key", () => {
		const older: OAuthCredential = { type: "oauth", access: "old", refresh: "r1", expires: 10 };
		const newer: OAuthCredential = { type: "oauth", access: "new", refresh: "r2", expires: 20 };
		expect(chooseXaiOAuth(older, newer)).toEqual(newer);
		expect(chooseXaiOAuth(newer, older)).toEqual(newer);
		expect(chooseXaiOAuth({ type: "api_key", key: "xai-api-key" }, newer)).toEqual({
			type: "api_key",
			key: "xai-api-key",
		});
	});
});

describe("grok CLI write-through", () => {
	it("updates tokens without dropping identity fields", () => {
		const home = tempDir();
		grokFile(home, liveGrok);
		const written = writeGrokCliXaiOAuth(
			{ type: "oauth", access: "fresh", refresh: "rotated", expires: 99 },
			{ grokHome: home },
		);
		expect(written).toBe(true);
		const parsed = JSON.parse(readFileSync(grokAuthPath(home), "utf-8")) as {
			[key: string]: Record<string, unknown>;
		};
		const entry = parsed[grokOidcEntryKey()];
		expect(entry).toMatchObject({
			key: "fresh",
			refresh_token: "rotated",
			expires_at: 99,
			email: "user@example.com",
			user_id: "user-1",
			auth_mode: "oidc",
		});
	});

	it("does not create ~/.grok/auth.json when the file is missing", () => {
		const home = tempDir();
		expect(
			writeGrokCliXaiOAuth(
				{ type: "oauth", access: "a", refresh: "r", expires: 1 },
				{ grokHome: home, onlyIfFileExists: true },
			),
		).toBe(false);
		expect(existsSync(grokAuthPath(home))).toBe(false);
	});
});

describe("wrapXaiGrokCliCredentials", () => {
	it("adopts a live Grok CLI token when lunR OAuth is dead", async () => {
		const home = tempDir();
		grokFile(home, liveGrok);
		const store = wrapXaiGrokCliCredentials(
			AuthStorage.inMemory({
				xai: { type: "oauth", access: "stale", refresh: "revoked", expires: 1 },
			}),
			{ grokHome: home },
		);
		await expect(store.read("xai")).resolves.toMatchObject({
			type: "oauth",
			access: "grok-access",
			refresh: "grok-refresh",
		});
		await expect(store.read("xai")).resolves.toMatchObject({ access: "grok-access" });
	});

	it("lists xai from Grok CLI when lunR has no xAI row", async () => {
		const home = tempDir();
		grokFile(home, liveGrok);
		const store = wrapXaiGrokCliCredentials(AuthStorage.inMemory({}), { grokHome: home });
		await expect(store.list()).resolves.toEqual([{ providerId: "xai", type: "oauth" }]);
	});

	it("write-throughs a refresh onto the Grok CLI file", async () => {
		const home = tempDir();
		grokFile(home, liveGrok);
		const store = wrapXaiGrokCliCredentials(
			AuthStorage.inMemory({
				xai: { type: "oauth", access: "stale", refresh: "revoked", expires: 0 },
			}),
			{ grokHome: home },
		);
		await store.modify("xai", async () => ({
			type: "oauth",
			access: "fresh",
			refresh: "rotated",
			expires: Date.now() + 1000,
		}));
		expect(readGrokCliXaiOAuth({ grokHome: home })).toMatchObject({
			access: "fresh",
			refresh: "rotated",
		});
	});

	it("ignores Grok CLI when lunR has an API key", async () => {
		const home = tempDir();
		grokFile(home, liveGrok);
		const store = wrapXaiGrokCliCredentials(AuthStorage.inMemory({ xai: { type: "api_key", key: "xai-api-key" } }), {
			grokHome: home,
		});
		await expect(store.read("xai")).resolves.toEqual({ type: "api_key", key: "xai-api-key" });
	});
});
