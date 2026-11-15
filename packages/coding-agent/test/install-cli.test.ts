import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInstallCli } from "../src/cli/install-cli.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { installBrowser } from "../src/core/browser/setup.ts";
import { configureStartup, teardownGatewayService } from "../src/gateway/service.ts";
import { setupGateway } from "../src/gateway/setup.ts";

vi.mock("../src/gateway/setup.ts", () => ({ setupGateway: vi.fn(async () => {}) }));
vi.mock("../src/cli/read-secret.ts", () => ({ readSecret: vi.fn(async () => "fixture-token") }));
vi.mock("../src/gateway/service.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/gateway/service.ts")>()),
	configureStartup: vi.fn(async () => {}),
	stopGatewayService: vi.fn(async () => "Gateway stopped."),
	teardownGatewayService: vi.fn(async () => {}),
}));

vi.mock("../src/core/browser/setup.ts", () => ({ installBrowser: vi.fn(async () => {}) }));

import { isFeatureEnabled, loadInstallFeatures, saveInstallFeatures } from "../src/core/install-features.ts";
import { saveInstallLayout } from "../src/core/install-layout.ts";
import { loadGatewayConfig } from "../src/gateway/config.ts";
import { runGateway } from "../src/gateway/index.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

let dir: string;
let prevAgentDir: string | undefined;
let ttyDescriptor: PropertyDescriptor | undefined;
let prevExitCode: typeof process.exitCode;

beforeEach(() => {
	vi.mocked(installBrowser).mockClear();
	vi.mocked(teardownGatewayService).mockReset().mockResolvedValue(undefined);
	vi.mocked(configureStartup).mockClear();
	vi.mocked(setupGateway).mockReset().mockResolvedValue(undefined);
	ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	dir = mkdtempSync(join(tmpdir(), "lunr-install-cli-"));
	prevAgentDir = process.env[ENV_AGENT_DIR];
	prevExitCode = process.exitCode;
	process.env[ENV_AGENT_DIR] = dir;
	process.exitCode = undefined;
});

afterEach(() => {
	if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = prevAgentDir;
	process.exitCode = prevExitCode;
	rmSync(dir, { recursive: true, force: true });
});

describe("handleInstallCli dispatch", () => {
	it("dispatches explicit browser repair without optional-feature enablement", async () => {
		expect(await handleInstallCli(["browser", "install"])).toBe(true);
		expect(installBrowser).toHaveBeenCalledOnce();
	});
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

	it("interactive setup installs the browser and keeps gateway wizard feature choices", async () => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		vi.mocked(setupGateway).mockImplementationOnce(async () => {
			const features = loadInstallFeatures();
			features.features["chat-platforms"] = { enabled: true, options: { autostart: true } };
			saveInstallFeatures(features);
		});
		await handleInstallCli(["setup"]);
		expect(installBrowser).toHaveBeenCalledWith(false);
		expect(setupGateway).toHaveBeenCalledOnce();
		expect(isFeatureEnabled("chat-platforms")).toBe(true);
		expect(loadInstallFeatures().features["chat-platforms"].options.autostart).toBe(true);
	});

	it("interactive explicit feature and set flags apply without overwriting choices in a wizard", async () => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		await handleInstallCli(["setup", "--feature", "chat-platforms", "--set", "chat-platforms.autostart=true"]);
		expect(installBrowser).toHaveBeenCalledWith(false);
		expect(setupGateway).not.toHaveBeenCalled();
		expect(configureStartup).toHaveBeenCalledWith("login");
		expect(loadInstallFeatures().features["chat-platforms"].options.autostart).toBe(true);
		await handleInstallCli(["setup", "--no-feature", "chat-platforms"]);
		expect(isFeatureEnabled("chat-platforms")).toBe(false);
	});

	it("interactive invalid flags fail before browser or gateway work", async () => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		await handleInstallCli(["setup", "--feature", "unknown"]);
		expect(process.exitCode).toBe(2);
		expect(installBrowser).not.toHaveBeenCalled();
		expect(setupGateway).not.toHaveBeenCalled();
	});

	it("npm purge preserves profile on teardown failure, then removes it after confirmed teardown", async () => {
		writeFileSync(join(dir, "auth.json"), "fixture");
		vi.mocked(teardownGatewayService).mockRejectedValueOnce(new Error("shutdown unconfirmed"));
		await expect(handleInstallCli(["uninstall", "--purge", "--yes"])).rejects.toThrow("shutdown unconfirmed");
		expect(existsSync(join(dir, "auth.json"))).toBe(true);
		vi.mocked(teardownGatewayService).mockImplementationOnce(async () => {
			expect(existsSync(join(dir, "auth.json"))).toBe(true);
		});
		await handleInstallCli(["uninstall", "--purge", "--yes"]);
		expect(existsSync(dir)).toBe(false);
	});

	it("standalone uninstall preserves binaries and profile when teardown fails", async () => {
		const prefix = join(dir, "prefix");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(join(prefix, "bin/lunr"), "inert");
		saveInstallLayout({
			schemaVersion: 1,
			prefix,
			method: "binary",
			argv0: join(prefix, "bin/lunr"),
			version: "0.1.0",
		});
		vi.mocked(teardownGatewayService).mockRejectedValueOnce(new Error("registration removal unconfirmed"));
		await expect(handleInstallCli(["uninstall", "--purge", "--yes"])).rejects.toThrow(
			"registration removal unconfirmed",
		);
		expect(existsSync(join(prefix, "bin/lunr"))).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});

	it("setup --yes defaults chat-platforms off", async () => {
		expect(await handleInstallCli(["setup", "--yes"])).toBe(true);
		expect(installBrowser).toHaveBeenCalledWith(false);
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

	it("standalone purge keeps unrelated files in a custom prefix", async () => {
		const prefix = join(dir, "prefix");
		const profile = join(dir, "agent");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(join(prefix, "keep.txt"), "unrelated");
		process.env[ENV_AGENT_DIR] = profile;
		saveInstallLayout({
			schemaVersion: 1,
			prefix,
			method: "binary",
			argv0: join(prefix, "bin/lunr"),
			version: "0.1.0",
		});
		await handleInstallCli(["uninstall", "--purge", "--yes"]);
		expect(existsSync(join(prefix, "keep.txt"))).toBe(true);
		expect(existsSync(profile)).toBe(false);
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
