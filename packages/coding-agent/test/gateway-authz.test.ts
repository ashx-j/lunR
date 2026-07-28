import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthorized } from "../src/gateway/authz.ts";
import { defaultGatewayConfig } from "../src/gateway/config.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import type { SessionSource } from "../src/gateway/types.ts";

let dir: string;
const ENV_KEYS = ["LUNR_GATEWAY_ALLOW_ALL_USERS", "LUNR_GATEWAY_ALLOWED_USERS"] as const;
const prevEnv = new Map<string, string | undefined>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-authz-"));
	for (const key of ENV_KEYS) {
		prevEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = prevEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	rmSync(dir, { recursive: true, force: true });
});

function source(overrides: Partial<SessionSource> = {}): SessionSource {
	return { platform: "telegram", chatId: "c1", chatType: "dm", userId: "u1", ...overrides };
}

describe("isAuthorized", () => {
	it("fails closed by default", () => {
		expect(isAuthorized(source(), defaultGatewayConfig(), createPairingStore({ dir }))).toBe(false);
	});

	it("layer 1: LUNR_GATEWAY_ALLOW_ALL_USERS=true allows anyone", () => {
		process.env.LUNR_GATEWAY_ALLOW_ALL_USERS = "true";
		expect(isAuthorized(source(), defaultGatewayConfig(), createPairingStore({ dir }))).toBe(true);
	});

	it("layer 2: chatId in allowedChats grants even userless messages", () => {
		const cfg = defaultGatewayConfig();
		cfg.telegram.allowedChats = ["c1"];
		expect(isAuthorized(source({ userId: "" }), cfg, createPairingStore({ dir }))).toBe(true);
	});

	it("layer 3: roleAuthorized grants", () => {
		expect(isAuthorized(source({ roleAuthorized: true }), defaultGatewayConfig(), createPairingStore({ dir }))).toBe(
			true,
		);
	});

	it("layer 4: paired users are authorized", () => {
		const pairing = createPairingStore({ dir });
		const code = pairing.issueCode("telegram", "u1")!;
		expect(isAuthorized(source(), defaultGatewayConfig(), pairing)).toBe(false);
		pairing.approve("telegram", code);
		expect(isAuthorized(source(), defaultGatewayConfig(), pairing)).toBe(true);
	});

	it("layer 5a: userId in the platform's allowedUsers", () => {
		const cfg = defaultGatewayConfig();
		cfg.telegram.allowedUsers = ["u1"];
		expect(isAuthorized(source(), cfg, createPairingStore({ dir }))).toBe(true);
		// Platform-scoped: a discord user with the same id is NOT authorized.
		expect(isAuthorized(source({ platform: "discord" }), cfg, createPairingStore({ dir }))).toBe(false);
	});

	it("layer 5b: userId in global LUNR_GATEWAY_ALLOWED_USERS", () => {
		process.env.LUNR_GATEWAY_ALLOWED_USERS = "someone, u1 ,other";
		expect(isAuthorized(source(), defaultGatewayConfig(), createPairingStore({ dir }))).toBe(true);
		expect(isAuthorized(source({ platform: "discord" }), defaultGatewayConfig(), createPairingStore({ dir }))).toBe(
			true,
		);
	});

	it("unknown platforms still pair via the store (fail-closed otherwise)", () => {
		const pairing = createPairingStore({ dir });
		expect(isAuthorized(source({ platform: "slack" }), defaultGatewayConfig(), pairing)).toBe(false);
		const code = pairing.issueCode("slack", "u1")!;
		pairing.approve("slack", code);
		expect(isAuthorized(source({ platform: "slack" }), defaultGatewayConfig(), pairing)).toBe(true);
	});
});
