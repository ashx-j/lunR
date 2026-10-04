import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: "",
	root: "",
	denySignals: false,
	failSpawn: false,
	children: [] as Array<{
		child: ChildProcess;
		path: string;
		ready: boolean;
		kill: ReturnType<typeof vi.fn>;
		realKill: ChildProcess["kill"];
		exited: Promise<void>;
	}>,
}));
vi.mock("../src/builtin-extensions/pi-web-access/utils.ts", () => ({
	getWebSearchConfigPath: () => state.config,
}));
vi.mock("../src/builtin-extensions/pi-web-access/github-api.ts", () => ({
	checkGhAvailable: async () => true,
	checkRepoSize: async () => null,
	fetchViaApi: async () => null,
	showGhHint: vi.fn(),
}));
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		execFile(
			_command: string,
			args: string[],
			options: { timeout?: number },
			callback: (error: Error | null) => void,
		) {
			const path = args[3];
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "README.md"), "# Inert clone fixture\n");
			// Only this disposable Node process runs. No git, gh, network or real profile access.
			const executable = state.failSpawn ? join(state.root, "missing-executable") : process.execPath;
			const child = actual.execFile(
				executable,
				[
					"-e",
					[
						"process.on('SIGTERM', () => {});",
						"process.stdin.on('data', () => process.exit(0));",
						"console.log('ready');",
						"setInterval(() => {}, 1000);",
					].join("\n"),
				],
				{
					...options,
					env: { HOME: state.root, USERPROFILE: state.root, NODE_ENV: "test" },
				},
				callback,
			);
			const realKill = child.kill.bind(child);
			const kill = vi.fn((signal?: NodeJS.Signals | number) => {
				if (!state.denySignals) return realKill(signal);
				// Reproduce Node's EPERM error path, including execFile's early callback with a live PID.
				child.emit("error", Object.assign(new Error("inert kill EPERM"), { code: "EPERM" }));
				return false;
			});
			child.kill = kill;
			const entry = {
				child,
				path,
				ready: false,
				kill,
				realKill,
				exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
			};
			state.children.push(entry);
			child.stdout?.on("data", (data: Buffer) => {
				if (data.toString().includes("ready")) entry.ready = true;
			});
			return child;
		},
	};
});

beforeEach(() => {
	vi.resetModules();
	state.children = [];
	state.denySignals = false;
	state.failSpawn = false;
	state.root = mkdtempSync(join(tmpdir(), "lunr-clone-termination-"));
	state.config = join(state.root, "web-search.json");
	writeFileSync(
		state.config,
		JSON.stringify({
			githubClone: { clonePath: join(state.root, "clones"), cloneTimeoutSeconds: 30 },
		}),
	);
});

async function reapChildren() {
	for (const entry of state.children) {
		if (entry.child.exitCode === null && entry.child.signalCode === null) entry.realKill("SIGKILL");
	}
	await Promise.all(state.children.map((entry) => entry.exited));
}
afterEach(async () => {
	await reapChildren();
	rmSync(state.root, { recursive: true, force: true });
});
async function runtime() {
	return {
		...(await import("../src/builtin-extensions/pi-web-access/github-extract.ts")),
		...(await import("../src/builtin-extensions/pi-web-access/session-cleanup.ts")),
	};
}
async function waitForChild(index = 0) {
	await vi.waitFor(() => expect(state.children[index]?.ready).toBe(true), { timeout: 3_000 });
	return state.children[index];
}

// Windows terminates Node on SIGTERM rather than allowing this Unix signal handler to ignore it.
describe.skipIf(process.platform === "win32")("confirmed GitHub clone termination", () => {
	it("settles a failed spawn without waiting for a nonexistent process exit", async () => {
		state.failSpawn = true;
		const rt = await runtime();
		const owner = rt.createWebSession();
		try {
			expect(
				await rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/inert/missing")),
			).toBeNull();
			expect(state.children[0].child.pid).toBeUndefined();
			await rt.runSessionCleanups(owner);
			expect(existsSync(state.children[0].path)).toBe(false);
		} finally {
			await reapChildren();
			await rt.runSessionCleanups(owner);
		}
	});

	it("escalates the configured timeout without requiring session shutdown", async () => {
		writeFileSync(
			state.config,
			JSON.stringify({
				githubClone: { clonePath: join(state.root, "clones"), cloneTimeoutSeconds: 0.25 },
			}),
		);
		const rt = await runtime();
		const owner = rt.createWebSession();
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/inert/timeout"));
		try {
			const entry = await waitForChild();
			expect(await pending).toBeNull();
			await entry.exited;
			expect(owner.closed).toBe(false);
			expect(entry.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(entry.child.signalCode).toBe("SIGKILL");
			expect(existsSync(entry.path)).toBe(false);
		} finally {
			await reapChildren();
			await Promise.allSettled([pending, rt.runSessionCleanups(owner)]);
		}
	}, 8_000);

	it("escalates final-owner shutdown and confirms the noncooperative command exits", async () => {
		const rt = await runtime();
		const owner = rt.createWebSession();
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/inert/stop"));
		try {
			const entry = await waitForChild();
			const closing = rt.runSessionCleanups(owner);
			expect(rt.runSessionCleanups(owner)).toBe(closing);
			await closing;
			await entry.exited;
			expect(entry.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(entry.child.signalCode).toBe("SIGKILL");
			expect(await pending).toBeNull();
			expect(existsSync(entry.path)).toBe(false);
		} finally {
			await reapChildren();
			await Promise.allSettled([pending, rt.runSessionCleanups(owner)]);
		}
	}, 8_000);

	it("uses one escalation when shutdown follows the configured timeout", async () => {
		writeFileSync(
			state.config,
			JSON.stringify({
				githubClone: { clonePath: join(state.root, "clones"), cloneTimeoutSeconds: 0.25 },
			}),
		);
		const rt = await runtime();
		const owner = rt.createWebSession();
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/inert/overlap"));
		try {
			const entry = await waitForChild();
			await vi.waitFor(() => expect(entry.kill).toHaveBeenCalledWith("SIGTERM"));
			await rt.runSessionCleanups(owner);
			await entry.exited;
			expect(entry.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(entry.child.signalCode).toBe("SIGKILL");
			expect(await pending).toBeNull();
		} finally {
			await reapChildren();
			await Promise.allSettled([pending, rt.runSessionCleanups(owner)]);
		}
	}, 8_000);

	it("does not signal a pending clone while another owner survives", async () => {
		const rt = await runtime();
		const first = rt.createWebSession();
		const second = rt.createWebSession();
		const a = rt.runWithWebSession(first, () => rt.extractGitHub("https://github.com/inert/shared"));
		const b = rt.runWithWebSession(second, () => rt.extractGitHub("https://github.com/inert/shared"));
		try {
			const entry = await waitForChild();
			await rt.runSessionCleanups(first);
			expect(entry.kill).not.toHaveBeenCalled();
			expect(entry.child.exitCode).toBeNull();
			expect(entry.child.signalCode).toBeNull();
			expect(state.children).toHaveLength(1);
			entry.child.stdin?.end("complete\n");
			await entry.exited;
			expect(await a).toBeNull();
			expect(await b).toMatchObject({ error: null });
			expect(existsSync(entry.path)).toBe(true);
			await rt.runSessionCleanups(second);
			expect(existsSync(entry.path)).toBe(false);
		} finally {
			await reapChildren();
			await Promise.allSettled([a, b, rt.runSessionCleanups(first), rt.runSessionCleanups(second)]);
		}
	});

	it("reports denied termination, reserves its output, and retries only after actual exit", async () => {
		const rt = await runtime();
		const owner = rt.createWebSession();
		const next = rt.createWebSession();
		state.denySignals = true;
		const pending = rt.runWithWebSession(owner, () => rt.extractGitHub("https://github.com/inert/denied"));
		try {
			const entry = await waitForChild();
			const closing = rt.runSessionCleanups(owner);
			await expect(closing).rejects.toThrow("clone retained until completion");
			expect(entry.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(entry.child.exitCode).toBeNull();
			expect(entry.child.signalCode).toBeNull();
			expect(existsSync(entry.path)).toBe(true);
			await expect(
				rt.runWithWebSession(next, () => rt.extractGitHub("https://github.com/inert/denied")),
			).rejects.toThrow("clone retained until completion");
			expect(state.children).toHaveLength(1);
			entry.realKill("SIGKILL");
			await entry.exited;
			expect(await pending).toBeNull();
			await vi.waitFor(() => expect(existsSync(entry.path)).toBe(false));
			state.denySignals = false;
			const retry = rt.runWithWebSession(next, () => rt.extractGitHub("https://github.com/inert/denied"));
			const replacement = await waitForChild(1);
			replacement.child.stdin?.end("complete\n");
			await replacement.exited;
			expect(await retry).toMatchObject({ error: null });
			await rt.runSessionCleanups(next);
			expect(existsSync(replacement.path)).toBe(false);
		} finally {
			await reapChildren();
			await Promise.allSettled([pending, rt.runSessionCleanups(owner), rt.runSessionCleanups(next)]);
		}
	}, 8_000);
});
