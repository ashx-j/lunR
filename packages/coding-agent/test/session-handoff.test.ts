import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	cancelSessionHandoff,
	HANDOFF_DURATION_MS,
	latestTuiSession,
	listHandoffCandidates,
	listRegisteredSessionPaths,
	markSessionHandoff,
	recordTuiActivity,
	registerTransferHandler,
	requestSessionTransfer,
	SessionTransferError,
} from "../src/core/session-handoff.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	canonicalSessionPath,
	readSessionOwner,
	SessionOwnershipError,
	sessionOwnershipDirectory,
} from "../src/core/session-ownership.ts";
import { pruneOldSessions } from "../src/core/session-retention.ts";

let directory: string;
let managers: SessionManager[];
let children: ChildProcess[];
let unregister: (() => void)[];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "lunr-handoff-"));
	managers = [];
	children = [];
	unregister = [];
});
afterEach(async () => {
	for (const stop of unregister) stop();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	}
	for (const manager of managers) manager.dispose();
	rmSync(directory, { recursive: true, force: true });
});
function saved(): SessionManager {
	const manager = SessionManager.create(directory, join(directory, "custom"));
	managers.push(manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	manager.flush();
	return manager;
}
async function childOwner(file: string, transfer = false): Promise<ChildProcess> {
	const source = new URL("../src/core/session-manager.ts", import.meta.url).href;
	const handoff = new URL("../src/core/session-handoff.ts", import.meta.url).href;
	const script = `import {SessionManager} from ${JSON.stringify(source)}; import {registerTransferHandler} from ${JSON.stringify(handoff)}; const manager = SessionManager.open(${JSON.stringify(file)}); ${transfer ? "registerTransferHandler(manager, async () => { manager.flush(); manager.dispose(); });" : ""} console.log('ready'); setInterval(()=>{},1000);`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "profile") },
	});
	children.push(child);
	let errors = "";
	child.stderr!.on("data", (data) => {
		errors += data;
	});
	await Promise.race([
		once(child.stdout!, "data"),
		once(child, "exit").then(() => {
			throw new Error(`Child failed: ${errors}`);
		}),
	]);
	return child;
}

describe("exclusive session ownership and handoff", () => {
	it("blocks a second process, never steals a live owner, and recovers only after verified death", async () => {
		const original = saved();
		const file = original.getSessionFile()!;
		original.dispose();
		const child = await childOwner(file);
		expect(() => SessionManager.open(file)).toThrow(SessionOwnershipError);
		expect(() => SessionManager.open(join(directory, "custom", "..", "custom", file.split(/[\\/]/).pop()!))).toThrow(
			SessionOwnershipError,
		);
		const owner = readSessionOwner(file)!;
		writeFileSync(join(sessionOwnershipDirectory(file), "owner.json"), JSON.stringify({ ...owner, heartbeatAt: 0 }));
		expect(() => SessionManager.open(file)).toThrow(SessionOwnershipError);
		const exited = once(child, "exit");
		child.kill();
		await exited;
		const next = SessionManager.open(file);
		managers.push(next);
		expect(next.getSessionId()).toBe(original.getSessionId());
		expect(next.getOwnership()!.owner.generation).not.toBe(owner.generation);
	}, 20_000);

	it("locks before migration, while read-only snapshots and lists never write", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		const legacy = `${JSON.stringify({
			type: "session",
			version: 2,
			id: manager.getSessionId(),
			cwd: directory,
			timestamp: new Date(0).toISOString(),
		})}\n`;
		writeFileSync(file, legacy);
		expect(() => SessionManager.open(file)).toThrow(SessionOwnershipError);
		const snapshot = SessionManager.openReadOnly(file);
		expect(() => snapshot.appendSessionInfo("no")).toThrow(SessionOwnershipError);
		await SessionManager.listAll(join(directory, "custom"));
		expect(readFileSync(file, "utf8")).toBe(legacy);
	});

	it("rejects unknown or foreign owners rather than assuming staleness", () => {
		const file = join(directory, "uncertain.jsonl");
		mkdirSync(sessionOwnershipDirectory(file));
		expect(() => SessionManager.open(file)).toThrow(/unknown/);
		writeFileSync(
			join(sessionOwnershipDirectory(file), "owner.json"),
			JSON.stringify({
				version: 1,
				file: canonicalSessionPath(file),
				generation: "old",
				pid: 2147483647,
				host: `${hostname()}-foreign`,
				instance: "old",
			}),
		);
		expect(() => SessionManager.open(file)).toThrow(SessionOwnershipError);
	});

	it.each(["branch", "root"])(
		"preserves %s leaf, original cwd, custom directory and permissions across reopen",
		(kind) => {
			const manager = saved();
			const file = manager.getSessionFile()!;
			const first = manager.getLeafId()!;
			manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
			manager.setPermissionMode("plan");
			if (kind === "root") manager.resetLeaf();
			else manager.branch(first);
			manager.dispose();
			expect(() => manager.appendSessionInfo("stale")).toThrow(SessionOwnershipError);
			const next = SessionManager.open(file);
			managers.push(next);
			expect(next.getLeafId()).toBe(kind === "root" ? null : first);
			expect(next.getCwd()).toBe(directory);
			expect(next.getSessionDir()).toBe(join(directory, "custom"));
			expect(next.getPermissionMode()).toBe("plan");
		},
	);

	it("marks for exactly eight hours, refreshes, cancels and keeps latest TUI activity independent of background appends", () => {
		const first = saved();
		const second = saved();
		const profile = join(directory, "profile");
		recordTuiActivity(first, profile, 1);
		recordTuiActivity(second, profile, 2);
		first.appendMessage({ role: "user", content: "background", timestamp: 3 });
		expect(latestTuiSession(profile)?.sessionId).toBe(second.getSessionId());
		markSessionHandoff(first, profile, 100);
		expect(listHandoffCandidates(profile, 100 + HANDOFF_DURATION_MS - 1)).toHaveLength(1);
		expect(listHandoffCandidates(profile, 100 + HANDOFF_DURATION_MS)).toHaveLength(0);
		markSessionHandoff(first, profile, 200);
		markSessionHandoff(second, profile, 300);
		expect(listHandoffCandidates(profile, 301).map((record) => record.sessionId)).toEqual([
			second.getSessionId(),
			first.getSessionId(),
		]);
		cancelSessionHandoff(first, profile);
		expect(listHandoffCandidates(profile, 301)).toHaveLength(1);
		expect(listRegisteredSessionPaths(profile)).toHaveLength(2);
	});

	it("gracefully transfers between real processes and the released manager cannot write", async () => {
		const original = saved();
		const file = original.getSessionFile()!;
		original.resetLeaf();
		original.dispose();
		await childOwner(file, true);
		await requestSessionTransfer(file);
		expect(readSessionOwner(file)).toBeUndefined();
		const destination = SessionManager.open(file);
		managers.push(destination);
		expect(destination.getLeafId()).toBeNull();
	}, 20_000);

	it("returns busy without aborting and allows explicit stop only through the owner", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		let stopped = false;
		unregister.push(
			registerTransferHandler(manager, async ({ stop }) => {
				if (!stop) throw new SessionTransferError("Wait, stop or cancel.", "busy");
				stopped = true;
				manager.dispose();
			}),
		);
		await expect(requestSessionTransfer(file)).rejects.toMatchObject({ code: "busy" });
		expect(stopped).toBe(false);
		manager.assertWritable();
		await requestSessionTransfer(file, { stop: true });
		expect(stopped).toBe(true);
		expect(() => manager.resetLeaf()).toThrow(SessionOwnershipError);
	});

	it("releases failed destination initialization so the saved session remains recoverable", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		await expect(
			createAgentSessionRuntime(
				async () => {
					throw new Error("factory failed");
				},
				{
					cwd: directory,
					agentDir: directory,
					sessionManager: manager,
				},
			),
		).rejects.toThrow("factory failed");
		expect(readSessionOwner(file)).toBeUndefined();
		const retry = SessionManager.open(file);
		managers.push(retry);
		expect(retry.buildSessionContext().messages).toHaveLength(1);
	});

	it("does not prune another runtime's owned session", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		const now = Date.now() + 10 * 24 * 60 * 60 * 1000;
		expect((await pruneOldSessions(join(directory, "custom"), 1, { now })).deleted).toEqual([]);
		manager.dispose();
		expect((await pruneOldSessions(join(directory, "custom"), 1, { now })).deleted).toEqual([file]);
	});

	it("cancels an accepted request before its owner commits release", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		let started!: () => void;
		const accepted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let observedCancellation!: () => void;
		const cancelled = new Promise<void>((resolve) => {
			observedCancellation = resolve;
		});
		unregister.push(
			registerTransferHandler(manager, async ({ signal }) => {
				started();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				observedCancellation();
				signal.throwIfAborted();
				manager.dispose();
			}),
		);
		const controller = new AbortController();
		const request = requestSessionTransfer(file, { signal: controller.signal });
		await accepted;
		controller.abort();
		await expect(request).rejects.toThrow();
		await cancelled;
		manager.assertWritable();
	});

	it("fails closed on unsupported owners and cancelled requests", async () => {
		const manager = saved();
		const file = manager.getSessionFile()!;
		await expect(requestSessionTransfer(file, { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
		manager.assertWritable();
		const controller = new AbortController();
		const request = requestSessionTransfer(file, { signal: controller.signal });
		controller.abort();
		await expect(request).rejects.toThrow();
		manager.assertWritable();
	});
});
