import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInstallCli } from "../src/cli/install-cli.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { isFeatureEnabled, loadInstallFeatures } from "../src/core/install-features.ts";
import { saveInstallLayout } from "../src/core/install-layout.ts";
import { loadGatewayConfig } from "../src/gateway/config.ts";
import { runGateway } from "../src/gateway/index.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

let dir: string;
let prevAgentDir: string | undefined;
let prevExitCode: typeof process.exitCode;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-install-cli-"));
	prevAgentDir = process.env[ENV_AGENT_DIR];
	prevExitCode = process.exitCode;
	process.env[ENV_AGENT_DIR] = dir;
	process.exitCode = undefined;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = prevAgentDir;
	process.exitCode = prevExitCode;
	rmSync(dir, { recursive: true, force: true });
});

describe("handleInstallCli dispatch", () => {
	it("does not claim uninstall <source>", async () => {
		expect(await handleInstallCli(["uninstall", "npm:@x"])).toBe(false);
	});

	it("does not claim uninstall -l / --help / --approve", async () => {
		expect(await handleInstallCli(["uninstall", "-l"])).toBe(false);
		expect(await handleInstallCli(["uninstall", "--help"])).toBe(false);
		expect(await handleInstallCli(["uninstall", "--approve"])).toBe(false);
		expect(await handleInstallCli(["uninstall", "-h"])).toBe(false);
	});

	it("claims product uninstall with no source", async () => {
		expect(await handleInstallCli(["uninstall", "--yes"])).toBe(true);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("npm-style uninstall prints npm rm -g @ashx-j/lunr", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await handleInstallCli(["uninstall", "--yes"])).toBe(true);
		const text = log.mock.calls.flat().join("\n");
		log.mockRestore();
		expect(text).toContain("npm rm -g @ashx-j/lunr");
	});

	it("setup --yes defaults chat-platforms off", async () => {
		expect(await handleInstallCli(["setup", "--yes"])).toBe(true);
		expect(process.exitCode ?? 0).toBe(0);
		expect(isFeatureEnabled("chat-platforms")).toBe(false);
		expect(existsSync(join(dir, "install-features.json"))).toBe(true);
	});

	it("setup --yes --feature chat-platforms persists env token to gateway.json", async () => {
		const prev = process.env.LUNR_TELEGRAM_BOT_TOKEN;
		process.env.LUNR_TELEGRAM_BOT_TOKEN = "from-env";
		try {
			expect(await handleInstallCli(["setup", "--yes", "--feature", "chat-platforms"])).toBe(true);
			expect(process.exitCode ?? 0).toBe(0);
			expect(isFeatureEnabled("chat-platforms")).toBe(true);
			const cfg = loadGatewayConfig();
			expect(cfg.telegram.token).toBe("from-env");
			expect(cfg.telegram.enabled).toBe(true);
			expect(loadInstallFeatures().features["chat-platforms"]?.options.telegramToken).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.LUNR_TELEGRAM_BOT_TOKEN;
			else process.env.LUNR_TELEGRAM_BOT_TOKEN = prev;
		}
	});

	it("rejects --set on a secret option with exit 2", async () => {
		expect(
			await handleInstallCli([
				"setup",
				"--yes",
				"--feature",
				"chat-platforms",
				"--set",
				"chat-platforms.telegram-token=leak",
			]),
		).toBe(true);
		expect(process.exitCode).toBe(2);
	});

	it("features enable / disable toggles the catalog flag", async () => {
		expect(await handleInstallCli(["features", "enable", "chat-platforms"])).toBe(true);
		expect(isFeatureEnabled("chat-platforms")).toBe(true);
		expect(await handleInstallCli(["features", "disable", "chat-platforms"])).toBe(true);
		expect(isFeatureEnabled("chat-platforms")).toBe(false);
	});

	it("product uninstall --purge --yes deletes prefix versions/bin and agent dir", async () => {
		const prefix = join(dir, "prefix");
		mkdirSync(join(prefix, "versions", "0.1.0", "lunr"), { recursive: true });
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(join(prefix, "bin", "lunr"), "shim", "utf-8");
		saveInstallLayout({
			schemaVersion: 1,
			prefix,
			method: "binary",
			argv0: join(prefix, "bin", "lunr"),
			version: "0.1.0",
		});
		writeFileSync(join(dir, "auth.json"), "{}", "utf-8");
		expect(await handleInstallCli(["uninstall", "--purge", "--yes"])).toBe(true);
		expect(existsSync(join(prefix, "versions"))).toBe(false);
		expect(existsSync(join(dir, "auth.json"))).toBe(false);
	});
});

describe("gateway gate", () => {
	it("runDaemon refuses when chat-platforms is disabled", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const code = await runGateway([]);
		const text = error.mock.calls.flat().join("\n");
		error.mockRestore();
		expect(code).toBe(1);
		expect(text).toMatch(/lunr features enable chat-platforms/);
	});

	it("status stays ungated and reports the feature flag", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const code = await runGateway(["status"]);
		const text = log.mock.calls.flat().join("\n");
		log.mockRestore();
		expect(code).toBe(0);
		expect(text).toMatch(/chat-platforms: disabled/);
	});
});

describe("package manager still owns uninstall <source>", () => {
	it("handlePackageCommand still parses uninstall npm:@x", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const claimed = await handlePackageCommand(["uninstall", "npm:@definitely-not-installed"]);
		spy.mockRestore();
		expect(claimed).toBe(true);
	});
});
