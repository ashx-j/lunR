import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInstallCli } from "../src/cli/install-cli.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { installBrowser } from "../src/core/browser/setup.ts";

vi.mock("../src/core/browser/setup.ts", () => ({ installBrowser: vi.fn(async () => {}) }));

import { saveInstallLayout } from "../src/core/install-layout.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

let dir: string;
let prevAgentDir: string | undefined;
let ttyDescriptor: PropertyDescriptor | undefined;
let prevExitCode: typeof process.exitCode;

beforeEach(() => {
	vi.mocked(installBrowser).mockClear();
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

	it("setup installs the browser and rejects unknown flags before doing so", async () => {
		expect(await handleInstallCli(["setup", "--feature", "chat-platforms"])).toBe(true);
		expect(process.exitCode).toBe(2);
		expect(installBrowser).not.toHaveBeenCalled();
		process.exitCode = undefined;
		expect(await handleInstallCli(["setup", "--yes"])).toBe(true);
		expect(installBrowser).toHaveBeenCalledWith(false);
		expect(process.exitCode ?? 0).toBe(0);
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

describe("package manager still owns uninstall <source>", () => {
	it("handlePackageCommand still parses uninstall npm:@x", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const claimed = await handlePackageCommand(["uninstall", "npm:@definitely-not-installed"]);
		spy.mockRestore();
		expect(claimed).toBe(true);
	});
});
