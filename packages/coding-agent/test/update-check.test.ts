import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleUpdateCli } from "../src/cli/update-cli.ts";
import { DEV_NPM_CLI_PACKAGE, NPM_CLI_PACKAGE } from "../src/config.ts";
import {
	checkForUpdate,
	isPublishedInstall,
	markUpdateNotified,
	npmLatestUrl,
	updateCheckPath,
} from "../src/core/update-check.ts";

describe("isPublishedInstall", () => {
	it("is false for the workspace package name", () => {
		expect(isPublishedInstall("@earendil-works/pi-coding-agent", NPM_CLI_PACKAGE)).toBe(false);
	});

	it("is true when package.json name is the public npm package", () => {
		expect(isPublishedInstall(NPM_CLI_PACKAGE, NPM_CLI_PACKAGE)).toBe(true);
	});
});

describe("checkForUpdate", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		dir = mkdtempSync(join(tmpdir(), "lunr-update-check-"));
		return dir;
	}

	it("keeps stable and dev update records separate", () => {
		const agentDir = tempDir();
		expect(updateCheckPath(agentDir)).not.toBe(updateCheckPath(agentDir, DEV_NPM_CLI_PACKAGE));
		expect(updateCheckPath(agentDir, DEV_NPM_CLI_PACKAGE)).toMatch(/update-check-dev\.json$/);
	});

	it("checks the dev package and names its update command", async () => {
		const requestedUrls: string[] = [];
		const result = await checkForUpdate({
			currentVersion: "0.2.13-dev.1.1",
			agentDir: tempDir(),
			published: true,
			packageName: DEV_NPM_CLI_PACKAGE,
			appName: "lunr-dev",
			fetchImpl: async (input) => {
				requestedUrls.push(String(input));
				return Response.json({ version: "0.2.13-dev.2.1" });
			},
			now: 1_000,
		});
		expect(requestedUrls).toEqual([npmLatestUrl(DEV_NPM_CLI_PACKAGE)]);
		expect(result?.notice).toBe("lunr-dev 0.2.13-dev.2.1 is available. Run lunr-dev update.");
	});

	it("skips workspace installs", async () => {
		const result = await checkForUpdate({
			currentVersion: "0.2.8",
			agentDir: tempDir(),
			published: false,
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		});
		expect(result).toBeUndefined();
	});

	it("skips offline", async () => {
		const result = await checkForUpdate({
			currentVersion: "0.2.8",
			agentDir: tempDir(),
			published: true,
			offline: true,
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		});
		expect(result).toBeUndefined();
	});

	it("nags once when latest is newer", async () => {
		const agentDir = tempDir();
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ version: "0.2.9" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const first = await checkForUpdate({
			currentVersion: "0.2.8",
			agentDir,
			published: true,
			fetchImpl,
			now: 1_000,
		});
		expect(first?.newer).toBe(true);
		expect(first?.notice).toBe("lunR 0.2.9 is available. Run lunr update.");
		markUpdateNotified(agentDir, "0.2.9");
		const second = await checkForUpdate({
			currentVersion: "0.2.8",
			agentDir,
			published: true,
			fetchImpl,
			now: 2_000,
		});
		expect(second?.newer).toBe(true);
		expect(second?.notice).toBeUndefined();
		const cached = JSON.parse(readFileSync(updateCheckPath(agentDir), "utf8")) as { latest: string };
		expect(cached.latest).toBe("0.2.9");
	});

	it("does not nag when current", async () => {
		const agentDir = tempDir();
		const first = await checkForUpdate({
			currentVersion: "0.2.9",
			agentDir,
			published: true,
			fetchImpl: async () =>
				new Response(JSON.stringify({ version: "0.2.9" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			now: 1_000,
		});
		expect(first?.newer).toBe(false);
		expect(first?.notice).toBeUndefined();
	});
});

describe("handleUpdateCli", () => {
	it("does not claim other commands", async () => {
		expect(await handleUpdateCli(["install", "npm:@x"])).toBe(false);
	});

	it("refuses workspace self-update", async () => {
		const error = [] as string[];
		expect(await handleUpdateCli(["update"], { published: false, error: (m) => error.push(m) })).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error.join("\n")).toContain("not a global");
	});

	it("no-ops when already current", async () => {
		const log = [] as string[];
		expect(
			await handleUpdateCli(["update"], {
				published: true,
				currentVersion: "0.2.8",
				log: (m) => log.push(m),
				error: () => {},
				check: async () => ({ latest: "0.2.8", current: "0.2.8", newer: false }),
			}),
		).toBe(true);
		expect(log.join("\n")).toContain("up to date");
	});

	it("installs the checked version when newer", async () => {
		const spawned: string[][] = [];
		expect(
			await handleUpdateCli(["update"], {
				published: true,
				currentVersion: "0.2.8",
				log: () => {},
				warn: () => {},
				error: () => {},
				packageDir: "/tmp/lunr",
				check: async () => ({ latest: "0.2.9", current: "0.2.8", newer: true }),
				spawn: async (cmd, argv) => {
					spawned.push([cmd, ...argv]);
					return 0;
				},
			}),
		).toBe(true);
		expect(spawned[0]?.join(" ")).toContain(`${NPM_CLI_PACKAGE}@0.2.9`);
		expect(spawned[0]?.join(" ")).toContain("install");
		expect(spawned[0]?.join(" ")).toContain("-g");
	});

	it("updates the separate dev package", async () => {
		const spawned: string[][] = [];
		expect(
			await handleUpdateCli(["update"], {
				published: true,
				currentVersion: "0.2.13-dev.1.1",
				npmPackage: DEV_NPM_CLI_PACKAGE,
				appName: "lunr-dev",
				log: () => {},
				warn: () => {},
				error: () => {},
				check: async () => ({
					latest: "0.2.13-dev.2.1",
					current: "0.2.13-dev.1.1",
					newer: true,
				}),
				spawn: async (command, argv) => {
					spawned.push([command, ...argv]);
					return 0;
				},
			}),
		).toBe(true);
		expect(spawned[0]?.join(" ")).toContain(`${DEV_NPM_CLI_PACKAGE}@0.2.13-dev.2.1`);
	});
});
