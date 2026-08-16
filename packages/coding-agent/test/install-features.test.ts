import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	applyFeatureFlags,
	CHAT_PLATFORMS_INFER_UNTIL,
	coerceBooleanSetValue,
	deliverMentionsChatPlatform,
	isFeatureEnabled,
	isProductUninstallArgv,
	loadInstallFeatures,
	parseFeatureFlags,
	parseSetAssignment,
	saveInstallFeatures,
	versionGte,
} from "../src/core/install-features.ts";
import { defaultGatewayConfig, saveGatewayConfig } from "../src/gateway/config.ts";

let dir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-install-features-"));
	prevAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = dir;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = prevAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("parseFeatureFlags", () => {
	it("parses --feature / --no-feature / --set / --yes", () => {
		const parsed = parseFeatureFlags([
			"--yes",
			"--feature",
			"chat-platforms",
			"--set",
			"chat-platforms.autostart=true",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.yes).toBe(true);
		expect(parsed.features).toEqual(["chat-platforms"]);
		expect(parsed.sets).toEqual([{ id: "chat-platforms", option: "autostart", value: "true" }]);
	});

	it("rejects unknown flags", () => {
		const parsed = parseFeatureFlags(["--autostart"]);
		expect(parsed.ok).toBe(false);
	});
});

describe("parseSetAssignment / coerceBooleanSetValue", () => {
	it("parses id.option=value", () => {
		expect(parseSetAssignment("chat-platforms.autostart=true")).toEqual({
			id: "chat-platforms",
			option: "autostart",
			value: "true",
		});
		expect(parseSetAssignment("bad")).toBeUndefined();
	});

	it("coerces true|false|1|0 only", () => {
		expect(coerceBooleanSetValue("true")).toBe(true);
		expect(coerceBooleanSetValue("1")).toBe(true);
		expect(coerceBooleanSetValue("false")).toBe(false);
		expect(coerceBooleanSetValue("0")).toBe(false);
		expect(coerceBooleanSetValue("yes")).toBeUndefined();
	});
});

describe("applyFeatureFlags", () => {
	it("rejects --set on a secret option", () => {
		const empty = loadInstallFeatures();
		const flags = parseFeatureFlags(["--feature", "chat-platforms", "--set", "chat-platforms.telegram-token=abc"]);
		expect(flags.ok).toBe(true);
		if (!flags.ok) return;
		const applied = applyFeatureFlags(empty, flags);
		expect(applied.ok).toBe(false);
		if (applied.ok) return;
		expect(applied.exitCode).toBe(2);
		expect(applied.error).toMatch(/secret/);
	});

	it("rejects --set when the feature is not being enabled", () => {
		const empty = loadInstallFeatures();
		const flags = parseFeatureFlags(["--set", "chat-platforms.autostart=true"]);
		expect(flags.ok).toBe(true);
		if (!flags.ok) return;
		const applied = applyFeatureFlags(empty, flags);
		expect(applied.ok).toBe(false);
		if (applied.ok) return;
		expect(applied.error).toMatch(/enable the feature first/);
	});

	it("rejects boolean values other than true|false|1|0", () => {
		const empty = loadInstallFeatures();
		const flags = parseFeatureFlags(["--feature", "chat-platforms", "--set", "chat-platforms.autostart=yes"]);
		expect(flags.ok).toBe(true);
		if (!flags.ok) return;
		const applied = applyFeatureFlags(empty, flags);
		expect(applied.ok).toBe(false);
	});

	it("enables chat-platforms and sets autostart", () => {
		const empty = loadInstallFeatures();
		const flags = parseFeatureFlags(["--feature", "chat-platforms", "--set", "chat-platforms.autostart=1"]);
		expect(flags.ok).toBe(true);
		if (!flags.ok) return;
		const applied = applyFeatureFlags(empty, flags);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.next.features["chat-platforms"]?.enabled).toBe(true);
		expect(applied.next.features["chat-platforms"]?.options.autostart).toBe(true);
	});
});

describe("isFeatureEnabled / infer", () => {
	it("defaults chat-platforms off when the file is missing", () => {
		expect(isFeatureEnabled("chat-platforms")).toBe(false);
	});

	it("infers enabled + autostart false from gateway.json file token", () => {
		const cfg = defaultGatewayConfig();
		cfg.telegram.enabled = true;
		cfg.telegram.token = "file-token";
		saveGatewayConfig(cfg);
		expect(isFeatureEnabled("chat-platforms")).toBe(true);
		const file = loadInstallFeatures();
		expect(file.features["chat-platforms"]?.options.autostart).toBe(false);
		expect(file.inferUntil).toBe(CHAT_PLATFORMS_INFER_UNTIL);
		expect(existsSync(join(dir, "install-features.json"))).toBe(true);
	});

	it("does not infer from env-only tokens", () => {
		const cfg = defaultGatewayConfig();
		cfg.telegram.enabled = true;
		saveGatewayConfig(cfg);
		const prev = process.env.LUNR_TELEGRAM_BOT_TOKEN;
		process.env.LUNR_TELEGRAM_BOT_TOKEN = "env-only";
		try {
			expect(isFeatureEnabled("chat-platforms")).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.LUNR_TELEGRAM_BOT_TOKEN;
			else process.env.LUNR_TELEGRAM_BOT_TOKEN = prev;
		}
	});

	it("honors a written file over infer", () => {
		saveInstallFeatures({
			schemaVersion: 1,
			installerVersion: "0.1.0",
			installMethod: "binary",
			installedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			features: { "chat-platforms": { enabled: false, options: {} } },
		});
		const cfg = defaultGatewayConfig();
		cfg.telegram.enabled = true;
		cfg.telegram.token = "file-token";
		saveGatewayConfig(cfg);
		expect(isFeatureEnabled("chat-platforms")).toBe(false);
	});
});

describe("isProductUninstallArgv", () => {
	it("claims empty / product-only flags", () => {
		expect(isProductUninstallArgv([])).toBe(true);
		expect(isProductUninstallArgv(["--purge"])).toBe(true);
		expect(isProductUninstallArgv(["--yes", "--purge"])).toBe(true);
		expect(isProductUninstallArgv(["-y"])).toBe(true);
	});

	it("does not claim package-manager argv", () => {
		expect(isProductUninstallArgv(["npm:@x"])).toBe(false);
		expect(isProductUninstallArgv(["-l"])).toBe(false);
		expect(isProductUninstallArgv(["--help"])).toBe(false);
		expect(isProductUninstallArgv(["--local"])).toBe(false);
		expect(isProductUninstallArgv(["--approve"])).toBe(false);
	});
});

describe("deliverMentionsChatPlatform", () => {
	it("detects telegram/discord targets", () => {
		expect(deliverMentionsChatPlatform("local")).toBe(false);
		expect(deliverMentionsChatPlatform("origin")).toBe(false);
		expect(deliverMentionsChatPlatform("telegram")).toBe(true);
		expect(deliverMentionsChatPlatform("discord:1")).toBe(true);
		expect(deliverMentionsChatPlatform("local, telegram:123")).toBe(true);
	});
});

describe("versionGte", () => {
	it("compares x.y.z", () => {
		expect(versionGte("0.2.0", "0.2.0")).toBe(true);
		expect(versionGte("0.2.1", "0.2.0")).toBe(true);
		expect(versionGte("0.1.9", "0.2.0")).toBe(false);
	});
});

describe("unknown feature ids are preserved", () => {
	it("keeps unknown ids on save/load", () => {
		const path = join(dir, "install-features.json");
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: 1,
				installerVersion: "0.1.0",
				installMethod: "binary",
				installedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				features: { "future-thing": { enabled: true, options: { n: 1 } } },
			}),
			"utf-8",
		);
		const loaded = loadInstallFeatures();
		expect(loaded.features["future-thing"]?.enabled).toBe(true);
		saveInstallFeatures(loaded);
		expect(loadInstallFeatures().features["future-thing"]?.options.n).toBe(1);
	});
});
