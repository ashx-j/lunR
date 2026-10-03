import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityMonitor } from "../src/builtin-extensions/pi-web-access/activity.ts";
import {
	createWebSession,
	runSessionCleanups,
	runWithWebSession,
} from "../src/builtin-extensions/pi-web-access/session-cleanup.ts";

const state = vi.hoisted(() => ({
	config: "",
	clones: [] as Array<{
		path: string;
		kill: ReturnType<typeof vi.fn>;
		complete: () => void;
	}>,
	checkRepoSize: vi.fn(),
	checkGhAvailable: vi.fn(),
}));
vi.mock("../src/builtin-extensions/pi-web-access/utils.ts", () => ({
	getWebSearchConfigPath: () => state.config,
}));
vi.mock("../src/builtin-extensions/pi-web-access/github-api.ts", () => ({
	checkGhAvailable: state.checkGhAvailable,
	checkRepoSize: state.checkRepoSize,
	fetchViaApi: async () => null,
	showGhHint: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFile(_command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) {
		const path = args[3];
		const child = new EventEmitter();
		const kill = vi.fn();
		state.clones.push({
			path,
			kill,
			complete: () => {
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, "README.md"), "# Fake repository\nFixture content");
				child.emit("exit", 0);
				callback(null);
			},
		});
		return Object.assign(child, { kill });
	},
}));

let root: string;
beforeEach(() => {
	vi.resetModules();
	state.clones = [];
	state.checkRepoSize.mockReset().mockResolvedValue(null);
	state.checkGhAvailable.mockReset().mockResolvedValue(true);
	root = mkdtempSync(join(tmpdir(), "lunr-clone-leases-"));
	state.config = join(root, "web-search.json");
	writeFileSync(state.config, JSON.stringify({ githubClone: { clonePath: join(root, "clones") } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Import the session scope together with each fresh extractor module instance.
async function runtime() {
	return {
		...(await import("../src/builtin-extensions/pi-web-access/github-extract.ts")),
		...(await import("../src/builtin-extensions/pi-web-access/session-cleanup.ts")),
	};
}

describe("session-owned GitHub clone leases", () => {
	it("releases a rejected clone on shutdown so another session can retry", async () => {
		const rt = await runtime();
		const first = rt.createWebSession();
		state.checkGhAvailable.mockRejectedValueOnce(new Error("inert startup failure"));
		await expect(
			rt.runWithWebSession(first, () => rt.extractGitHub("https://github.com/example/retry")),
		).rejects.toThrow("inert startup failure");
		await rt.runSessionCleanups(first);
		const second = rt.createWebSession();
		const pending = rt
			.runWithWebSession(second, () => rt.extractGitHub("https://github.com/example/retry"))
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.clones).toHaveLength(1));
		state.clones[0].complete();
		expect(await pending).toMatchObject({ error: null });
		await rt.runSessionCleanups(second);
	});

	it("shares one pending clone and keeps it alive until the last owner closes", async () => {
		const rt = await runtime();
		const first = rt.createWebSession();
		const second = rt.createWebSession();
		const a = rt.runWithWebSession(first, () => rt.extractGitHub("https://github.com/example/project"));
		const b = rt.runWithWebSession(second, () => rt.extractGitHub("https://github.com/example/project"));
		await vi.waitFor(() => expect(state.clones).toHaveLength(1));
		await rt.runSessionCleanups(first);
		expect(state.clones[0].kill).not.toHaveBeenCalled();
		state.clones[0].complete();
		await Promise.all([a, b]);
		expect(existsSync(state.clones[0].path)).toBe(true);
		await rt.runSessionCleanups(second);
		expect(existsSync(state.clones[0].path)).toBe(false);
	});

	it("acquires a cached clone before a concurrent owner can tear it down", async () => {
		const rt = await runtime();
		const first = rt.createWebSession();
		const second = rt.createWebSession();
		const a = rt.runWithWebSession(first, () => rt.extractGitHub("https://github.com/example/cached"));
		await vi.waitFor(() => expect(state.clones).toHaveLength(1));
		state.clones[0].complete();
		await a;
		const b = rt.runWithWebSession(second, () => rt.extractGitHub("https://github.com/example/cached"));
		await rt.runSessionCleanups(first);
		expect(await b).toMatchObject({ error: null });
		expect(existsSync(state.clones[0].path)).toBe(true);
		expect(state.clones).toHaveLength(1);
		await rt.runSessionCleanups(second);
	});

	it("cancels one caller's wait without killing another owner's clone", async () => {
		const rt = await runtime();
		const first = rt.createWebSession();
		const second = rt.createWebSession();
		const controller = new AbortController();
		const a = rt.runWithWebSession(first, () =>
			rt.extractGitHub("https://github.com/example/cancel", controller.signal),
		);
		const b = rt.runWithWebSession(second, () => rt.extractGitHub("https://github.com/example/cancel"));
		await vi.waitFor(() => expect(state.clones).toHaveLength(1));
		controller.abort();
		expect(await a).toBeNull();
		await rt.runSessionCleanups(first);
		expect(state.clones[0].kill).not.toHaveBeenCalled();
		state.clones[0].complete();
		expect(await b).toMatchObject({ error: null });
		await rt.runSessionCleanups(second);
	});

	it("waits for the final owner's pending clone and removes late output", async () => {
		const rt = await runtime();
		const owner = rt.createWebSession();
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/example/pending"));
		await vi.waitFor(() => expect(state.clones).toHaveLength(1));
		let settled = false;
		const shutdown = rt.runSessionCleanups(owner).then(() => {
			settled = true;
		});
		expect(state.clones[0].kill).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		const repeatedShutdown = rt.runSessionCleanups(owner);
		let repeatedSettled = false;
		void repeatedShutdown.then(() => {
			repeatedSettled = true;
		});
		await Promise.resolve();
		expect(repeatedSettled).toBe(false);
		state.clones[0].complete();
		await Promise.all([shutdown, pending]);
		expect(existsSync(state.clones[0].path)).toBe(false);
	});

	it("refuses late clone acquisition after shutdown during the size lookup", async () => {
		const rt = await runtime();
		let release!: () => void;
		state.checkRepoSize.mockImplementation(
			() =>
				new Promise<null>((resolve) => {
					release = () => resolve(null);
				}),
		);
		const owner = rt.createWebSession();
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/example/late"));
		await vi.waitFor(() => expect(state.checkRepoSize).toHaveBeenCalledOnce());
		await rt.runSessionCleanups(owner);
		release();
		expect(await pending).toBeNull();
		expect(state.clones).toHaveLength(0);
	});
});

describe("session activity ownership", () => {
	it("routes overlapping async activity and cleanup to each monitor", async () => {
		const first = createWebSession();
		const second = createWebSession();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = runWithWebSession(first, async () => {
			const id = activityMonitor.logStart({ type: "fetch", url: "first" });
			await gate;
			activityMonitor.logComplete(id, 200);
		});
		runWithWebSession(second, () => activityMonitor.logStart({ type: "api", query: "second" }));
		await runSessionCleanups(second);
		second.activity.clear();
		release();
		await pending;
		expect(first.activity.getEntries()).toMatchObject([{ url: "first", status: 200 }]);
		expect(second.activity.getEntries()).toEqual([]);
	});
});
