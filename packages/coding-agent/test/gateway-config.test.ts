import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultGatewayConfig,
	gatewayConfigPath,
	loadGatewayConfig,
	resolvePlatformToken,
	saveGatewayConfig,
} from "../src/gateway/config.ts";

let dir: string;
let prevAgentDir: string | undefined;
const ENV_KEYS = ["LUNR_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"] as const;
const prevEnv = new Map<string, string | undefined>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-config-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	for (const key of ENV_KEYS) {
		prevEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
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

describe("loadGatewayConfig", () => {
	it("returns defaults with both platforms disabled when the file is missing", () => {
		const cfg = loadGatewayConfig();
		expect(cfg.telegram.enabled).toBe(false);
		expect(cfg.discord.enabled).toBe(false);
		expect(cfg.telegram.requireMention).toBe(false);
		expect(cfg.discord.requireMention).toBe(true);
		expect(cfg.discord.autoThread).toBe(true);
		expect(cfg.groupSessionsPerUser).toBe(true);
		expect(cfg.unauthorizedDmBehavior).toBe("pair");
		expect(cfg.streaming).toEqual({ enabled: true, editIntervalMs: 800, bufferThreshold: 24 });
	});

	it("tolerates a malformed file and falls back to defaults", () => {
		writeFileSync(gatewayConfigPath(), "{not json", "utf-8");
		expect(loadGatewayConfig()).toEqual(defaultGatewayConfig());
	});

	it("round-trips a saved config and drops unknown keys", () => {
		const cfg = defaultGatewayConfig();
		cfg.telegram.enabled = true;
		cfg.telegram.allowedUsers = ["u1"];
		cfg.streaming.editIntervalMs = 500;
		saveGatewayConfig(cfg);
		const loaded = loadGatewayConfig();
		expect(loaded.telegram.enabled).toBe(true);
		expect(loaded.telegram.allowedUsers).toEqual(["u1"]);
		expect(loaded.streaming.editIntervalMs).toBe(500);
	});

	it("merges a partial file over defaults", () => {
		writeFileSync(gatewayConfigPath(), JSON.stringify({ telegram: { enabled: true }, bogus: 1 }), "utf-8");
		const cfg = loadGatewayConfig();
		expect(cfg.telegram.enabled).toBe(true);
		expect(cfg.telegram.requireMention).toBe(false);
		expect(cfg.discord.autoThread).toBe(true);
		expect("bogus" in cfg).toBe(false);
	});
});

describe("resolvePlatformToken", () => {
	it("prefers LUNR_<PLATFORM>_BOT_TOKEN over <PLATFORM>_BOT_TOKEN over the file token", () => {
		const platformCfg = { ...defaultGatewayConfig().telegram, token: "file-token" };
		expect(resolvePlatformToken("telegram", platformCfg)).toBe("file-token");

		process.env.TELEGRAM_BOT_TOKEN = "plain-env";
		expect(resolvePlatformToken("telegram", platformCfg)).toBe("plain-env");

		process.env.LUNR_TELEGRAM_BOT_TOKEN = "lunr-env";
		expect(resolvePlatformToken("telegram", platformCfg)).toBe("lunr-env");
	});

	it("returns undefined when nothing resolves", () => {
		expect(resolvePlatformToken("telegram", defaultGatewayConfig().telegram)).toBeUndefined();
	});
});
