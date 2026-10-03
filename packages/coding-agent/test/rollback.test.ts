import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("node:os", async (importOriginal) => {
	const os = await importOriginal<typeof import("node:os")>();
	const fs = await import("node:fs");
	const { join } = await import("node:path");
	const home = fs.mkdtempSync(join(os.tmpdir(), "lunr-rollback-home-"));
	return { ...os, homedir: () => home };
});
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

// We test the rollback module directly with a mock settings manager.
// The module is stateful, so we import it dynamically.

const hasGit = (() => {
	try {
		const r = spawnSync("git", ["--version"]);
		return !r.error && r.status === 0;
	} catch {
		return false;
	}
})();

function initGitRepo(dir: string): void {
	spawnSync("git", ["init"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "rollback-test@example.com"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "rollback-test"], { cwd: dir });
}

describe("rollback", () => {
	let testDir: string;
	let mockSM: Partial<SettingsManager>;

	beforeEach(async () => {
		testDir = join(tmpdir(), `rollback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });

		mockSM = {
			getRollbackEnabled: () => true,
			getRollbackTurns: () => 2,
			getRollbackCapture: () => "copies",
			getRollbackScope: () => "tools",
		};

		const rollback = await import("../src/core/rollback.ts");
		rollback.clearRollback();
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		rollback.enableRollbackForSession();
	});

	afterEach(async () => {
		vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
		vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realFs.unlinkSync);
		const rollback = await import("../src/core/rollback.ts");
		rollback.clearRollback();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("snapshots and restores file content", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const filePath = join(testDir, "test.ts");
		writeFileSync(filePath, "original content");

		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);

		// Simulate an edit
		writeFileSync(filePath, "modified content");
		expect(readFileSync(filePath, "utf8")).toBe("modified content");

		// Rollback should restore original content
		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original content");
	});

	it("retains failed snapshots and retries the same turn after restart without rewriting completed paths", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackTurns = () => 5;
		const successful = join(testDir, "successful.txt");
		const failed = join(testDir, "failed.txt");
		const created = join(testDir, "created.txt");
		for (const file of [successful, failed]) writeFileSync(file, "original");
		rollback.beginTurn(testDir);
		for (const file of [successful, failed, created]) rollback.rollbackSnapshotBeforeWrite(file);
		for (const file of [successful, failed, created]) writeFileSync(file, "modified");
		rollback.beginTurn(testDir); // Chat-only turn must still count on retry.
		vi.mocked(fs.writeFileSync).mockImplementation((file, ...args) => {
			if (file === failed) throw new Error("locked destination");
			return realFs.writeFileSync(file, ...args);
		});
		vi.mocked(fs.unlinkSync).mockImplementation((file) => {
			if (file === created) throw new Error("locked deletion");
			return realFs.unlinkSync(file);
		});
		const first = rollback.rollbackLastTurn();
		expect(first.restored).toEqual([successful]);
		expect(first).toMatchObject({ complete: false, turnsConsumed: 0 });
		expect(first.failed.map((item) => item.path)).toEqual([failed, created]);
		const turnDir = join(homedir(), ".lunr", "rollback", "test-session", "turn-0");
		expect(fs.readdirSync(turnDir).filter((name) => name.endsWith(".snap"))).toHaveLength(2);
		writeFileSync(successful, "newer edit");
		vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
		vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		expect(rollback.peekRollbackTurnsConsumed()).toBe(2);
		const retry = rollback.rollbackLastTurn();
		expect(retry).toMatchObject({ complete: true, restored: [failed], deleted: [created], turnsConsumed: 2 });
		expect(readFileSync(successful, "utf8")).toBe("newer edit");
		expect(readFileSync(failed, "utf8")).toBe("original");
		expect(existsSync(turnDir)).toBe(false);
	});

	it("retains older recovery through retention and refuses retries across newer turns", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackTurns = () => 1;
		const old = join(testDir, "old.txt");
		writeFileSync(old, "original");
		rollback.beginTurn(testDir);
		rollback.rollbackSnapshotBeforeWrite(old);
		writeFileSync(old, "modified");
		vi.mocked(fs.writeFileSync).mockImplementation((file, ...args) => {
			if (file === old) throw new Error("locked");
			return realFs.writeFileSync(file, ...args);
		});
		expect(rollback.rollbackLastTurn(undefined, { targetUserId: "original-user" }).complete).toBe(false);
		rollback.beginTurn(testDir);
		const newer = join(testDir, "newer.txt");
		writeFileSync(newer, "newer original");
		rollback.rollbackSnapshotBeforeWrite(newer);
		writeFileSync(newer, "newer modified");
		vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		expect(rollback.getRollbackTargetUserId()).toBe("original-user");
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(() => rollback.rollbackLastTurn()).toThrow("after newer turns");
			expect(readFileSync(old, "utf8")).toBe("modified");
			expect(readFileSync(newer, "utf8")).toBe("newer modified");
		}
	});

	it("retains unreadable snapshot metadata so restoring its payload permits retry", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const file = join(testDir, "missing-snapshot.txt");
		writeFileSync(file, "original");
		rollback.beginTurn(testDir);
		rollback.rollbackSnapshotBeforeWrite(file);
		writeFileSync(file, "modified");
		const turnDir = join(homedir(), ".lunr", "rollback", "test-session", "turn-0");
		const manifest = JSON.parse(readFileSync(join(turnDir, "manifest.json"), "utf8"));
		const payload = join(turnDir, manifest.files[file].snapFile);
		const saved = readFileSync(payload);
		rmSync(payload);
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		const first = rollback.rollbackLastTurn();
		expect(first).toMatchObject({ complete: false, restored: [], turnsConsumed: 0 });
		expect(first.failed).toHaveLength(1);
		writeFileSync(payload, saved);
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		expect(rollback.rollbackLastTurn()).toMatchObject({ complete: true, restored: [file] });
		expect(readFileSync(file, "utf8")).toBe("original");
	});

	it("keeps successful recovery pending until the chat rewind is committed", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const file = join(testDir, "fork-retry.txt");
		writeFileSync(file, "original");
		rollback.beginTurn(testDir);
		rollback.rollbackSnapshotBeforeWrite(file);
		writeFileSync(file, "modified");
		const first = rollback.rollbackLastTurn(undefined, { deferCommit: true, targetUserId: "rewind-user" });
		expect(first).toMatchObject({ complete: true, turnsConsumed: 0, restored: [file], turnIndex: 0 });
		writeFileSync(file, "newer edit");
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		expect(rollback.getRollbackTargetUserId()).toBe("rewind-user");
		expect(rollback.rollbackLastTurn(undefined, { deferCommit: true })).toMatchObject({
			complete: true,
			restored: [],
			turnIndex: 0,
		});
		expect(readFileSync(file, "utf8")).toBe("newer edit");
		rollback.migrateRollbackSession("test-session", "forked-session");
		rollback.commitRollbackTurn("forked-session", 0);
		expect(rollback.getRollbackStatus("forked-session").turns).toBe(0);
	});

	it("does not restore files if the recovery manifest cannot be committed", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const file = join(testDir, "manifest-failure.txt");
		writeFileSync(file, "original");
		rollback.beginTurn(testDir);
		rollback.rollbackSnapshotBeforeWrite(file);
		writeFileSync(file, "modified");
		vi.mocked(fs.writeFileSync).mockImplementation((destination, ...args) => {
			if (String(destination).endsWith(".tmp")) throw new Error("manifest write failed");
			return realFs.writeFileSync(destination, ...args);
		});
		expect(() => rollback.rollbackLastTurn()).toThrow("manifest write failed");
		expect(readFileSync(file, "utf8")).toBe("modified");
		expect(() => rollback.commitRollbackTurn("test-session", 0)).toThrow("unrestored");
		vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
		expect(rollback.rollbackLastTurn()).toMatchObject({ complete: true, restored: [file] });
	});

	it("keeps chat-only rewind targets pending across a cancelled fork and restart", async () => {
		const rollback = await import("../src/core/rollback.ts");
		rollback.beginTurn(testDir);
		rollback.beginTurn(testDir);
		const first = rollback.rollbackLastTurn(undefined, { deferCommit: true, targetUserId: "first-chat-user" });
		expect(first).toMatchObject({ complete: true, turnIndex: 0, turnsConsumed: 0 });
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		expect(rollback.getRollbackTargetUserId()).toBe("first-chat-user");
		expect(rollback.peekRollbackTurnsConsumed()).toBe(2);
		const retry = rollback.rollbackLastTurn(undefined, { deferCommit: true });
		expect(retry).toMatchObject({ complete: true, turnIndex: 0, turnsConsumed: 0 });
		rollback.commitRollbackTurn("test-session", 0);
		expect(rollback.getRollbackStatus().turns).toBe(0);
	});

	it("does not overwrite newer edits after restart if a restore receipt could not be saved", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const file = join(testDir, "receipt-failure.txt");
		writeFileSync(file, "original");
		rollback.beginTurn(testDir);
		rollback.rollbackSnapshotBeforeWrite(file);
		writeFileSync(file, "modified");
		let manifestWrites = 0;
		vi.mocked(fs.writeFileSync).mockImplementation((destination, ...args) => {
			if (String(destination).endsWith(".tmp") && ++manifestWrites === 3) throw new Error("receipt write failed");
			return realFs.writeFileSync(destination, ...args);
		});
		const first = rollback.rollbackLastTurn();
		expect(first).toMatchObject({ complete: false, restored: [file], turnsConsumed: 0 });
		writeFileSync(file, "newer edit");
		vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		const retry = rollback.rollbackLastTurn();
		expect(retry).toMatchObject({ complete: false, restored: [], turnsConsumed: 0 });
		expect(retry.failed[0].error).toContain("uncertain");
		expect(readFileSync(file, "utf8")).toBe("newer edit");
		// Manually recovering the uncertain path confirms completion without replay.
		writeFileSync(file, "original");
		expect(rollback.rollbackLastTurn()).toMatchObject({ complete: true, restored: [], turnsConsumed: 1 });
	});

	it("copies mode deletes tool-created files", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const filePath = join(testDir, "created.ts");
		expect(existsSync(filePath)).toBe(false);

		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);

		// Simulate the agent creating the file
		writeFileSync(filePath, "new content");
		expect(existsSync(filePath)).toBe(true);

		const result = rollback.rollbackLastTurn();
		expect(result.deleted).toContain(filePath);
		expect(existsSync(filePath)).toBe(false);
	});

	it("hybrid mode deletes agent-created files", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackCapture = () => "hybrid";

		const filePath = join(testDir, "created.ts");
		// File doesn't exist yet
		expect(existsSync(filePath)).toBe(false);

		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);

		// Simulate the agent creating the file
		writeFileSync(filePath, "new content");
		expect(existsSync(filePath)).toBe(true);

		const result = rollback.rollbackLastTurn();
		expect(result.deleted).toContain(filePath);
		expect(existsSync(filePath)).toBe(false);
	});

	it("skips empty turns and restores the newest non-empty turn", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const filePath = join(testDir, "nonempty.ts");
		writeFileSync(filePath, "original");

		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);
		writeFileSync(filePath, "modified");

		// A user message with no file changes pushes an empty turn on top.
		rollback.beginTurn();

		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original");
	});

	it("reloads persisted snapshots from disk after re-init (restart)", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const sid = `test-session-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			rollback.initRollback(mockSM as SettingsManager, sid);
			rollback.enableRollbackForSession();

			const filePath = join(testDir, "reload.ts");
			writeFileSync(filePath, "original");
			rollback.beginTurn();
			rollback.rollbackSnapshotBeforeWrite(filePath);
			writeFileSync(filePath, "modified");

			// Simulate a restart: fresh init against the same session id.
			rollback.initRollback(mockSM as SettingsManager, sid);
			rollback.enableRollbackForSession();

			const result = rollback.rollbackLastTurn();
			expect(result.restored).toContain(filePath);
			expect(readFileSync(filePath, "utf8")).toBe("original");
		} finally {
			rollback.initRollback(mockSM as SettingsManager, sid);
			rollback.clearRollback();
		}
	});

	it.skipIf(!hasGit)("tree scope restores bash-modified tracked files from HEAD", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackScope = () => "tree";
		initGitRepo(testDir);

		const filePath = join(testDir, "tracked.txt");
		writeFileSync(filePath, "original");
		spawnSync("git", ["add", "."], { cwd: testDir });
		spawnSync("git", ["commit", "-m", "init"], { cwd: testDir });

		rollback.beginTurn(testDir); // baseline: clean tree → nothing snapshotted
		writeFileSync(filePath, "modified by bash");
		rollback.captureTreeChanges(testDir); // picks up the change, original = HEAD content

		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original");
	});

	it.skipIf(!hasGit)("tree scope: copies keeps bash-created files, hybrid deletes them", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackScope = () => "tree";
		initGitRepo(testDir);

		// copies: created-outside-tools file survives rollback
		const copiesFile = join(testDir, "bash-created-copies.txt");
		rollback.beginTurn(testDir);
		writeFileSync(copiesFile, "from bash");
		rollback.captureTreeChanges(testDir);
		const copiesResult = rollback.rollbackLastTurn();
		expect(copiesResult.deleted).not.toContain(copiesFile);
		expect(existsSync(copiesFile)).toBe(true);
		rmSync(copiesFile);

		// hybrid: created-outside-tools file is deleted
		mockSM.getRollbackCapture = () => "hybrid";
		const hybridFile = join(testDir, "bash-created-hybrid.txt");
		rollback.beginTurn(testDir);
		writeFileSync(hybridFile, "from bash");
		rollback.captureTreeChanges(testDir);
		const hybridResult = rollback.rollbackLastTurn();
		expect(hybridResult.deleted).toContain(hybridFile);
		expect(existsSync(hybridFile)).toBe(false);
	});

	it("skips restoring paths outside the session cwd or lunR config dir", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const outside = join(tmpdir(), `rollback-outside-${Date.now()}.txt`);
		writeFileSync(outside, "outside");
		rollback.beginTurn(testDir); // cwd recorded
		rollback.rollbackSnapshotBeforeWrite(outside);
		writeFileSync(outside, "modified");
		const result = rollback.rollbackLastTurn();
		expect(result.restored).not.toContain(outside);
		expect(readFileSync(outside, "utf8")).toBe("modified");
	});

	it("skips unchanged tree-scope baseline files", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackScope = () => "tree";
		initGitRepo(testDir);
		const filePath = join(testDir, "unchanged.txt");
		writeFileSync(filePath, "original");
		spawnSync("git", ["add", "."], { cwd: testDir });
		spawnSync("git", ["commit", "-m", "init"], { cwd: testDir });

		rollback.beginTurn(testDir);
		// No modification during the turn.
		rollback.captureTreeChanges(testDir);

		const result = rollback.rollbackLastTurn();
		expect(result.restored).not.toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original");
	});

	it("disabled rollback is a no-op", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackEnabled = () => false;
		rollback.disableRollbackForSession();

		const filePath = join(testDir, "noop.ts");
		writeFileSync(filePath, "original");
		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);
		writeFileSync(filePath, "modified");

		const result = rollback.rollbackLastTurn();
		expect(result.restored).toEqual([]);
		expect(readFileSync(filePath, "utf8")).toBe("modified");
	});

	it("retention prunes old turns", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackTurns = () => 1;

		const file1 = join(testDir, "file1.ts");
		writeFileSync(file1, "v1");
		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(file1);
		writeFileSync(file1, "v1-modified");

		// New turn
		const file2 = join(testDir, "file2.ts");
		writeFileSync(file2, "v2");
		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(file2);
		writeFileSync(file2, "v2-modified");

		// Only the last turn should be restorable (retention = 1)
		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(file2);
		expect(readFileSync(file2, "utf8")).toBe("v2");
		// file1 was pruned
		expect(readFileSync(file1, "utf8")).toBe("v1-modified");
	});

	it("isolates turns per session id", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const sidA = "session-a";
		const sidB = "session-b";
		rollback.initRollback(mockSM as SettingsManager, sidA);
		rollback.enableRollbackForSession(sidA);
		rollback.beginTurn(undefined, sidA);
		const fileA = join(testDir, "a.ts");
		writeFileSync(fileA, "A");
		rollback.rollbackSnapshotBeforeWrite(fileA, sidA);

		rollback.initRollback(mockSM as SettingsManager, sidB);
		rollback.enableRollbackForSession(sidB);
		rollback.beginTurn(undefined, sidB);
		const fileB = join(testDir, "b.ts");
		writeFileSync(fileB, "B");
		rollback.rollbackSnapshotBeforeWrite(fileB, sidB);

		expect(rollback.getRollbackStatus(sidA).files).toBe(1);
		expect(rollback.getRollbackStatus(sidB).files).toBe(1);

		// Rolling back session A should only touch fileA.
		const resultA = rollback.rollbackLastTurn(sidA);
		expect(resultA.restored).toContain(fileA);
		expect(resultA.restored).not.toContain(fileB);
		expect(rollback.getRollbackStatus(sidA).turns).toBe(0);
		expect(rollback.getRollbackStatus(sidB).turns).toBe(1);

		rollback.clearRollback();
	});

	// B1: agent config / cron jobs.json / memory.md are snapshotted by the agent
	// hook — they must actually restore, not be skipped by the root check.
	it("restores snapshots under the lunR config dir and the memory dir", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const suffix = `rollback-b1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const agentDir = join(homedir(), CONFIG_DIR_NAME, "agent");
		const memoryDir = join(homedir(), CONFIG_DIR_NAME, "simple-memory");
		const behaviorFile = join(agentDir, `behavior-${suffix}.md`);
		const jobsFile = join(agentDir, "cron", `jobs-${suffix}.json`);
		const memoryFile = join(memoryDir, `memory-${suffix}.md`);
		mkdirSync(join(agentDir, "cron"), { recursive: true });
		mkdirSync(memoryDir, { recursive: true });
		try {
			for (const file of [behaviorFile, jobsFile, memoryFile]) {
				writeFileSync(file, "original");
			}
			rollback.beginTurn(testDir); // cwd recorded — config/memory roots must still allow
			for (const file of [behaviorFile, jobsFile, memoryFile]) {
				rollback.rollbackSnapshotBeforeWrite(file);
				writeFileSync(file, "modified");
			}
			const result = rollback.rollbackLastTurn();
			for (const file of [behaviorFile, jobsFile, memoryFile]) {
				expect(result.restored).toContain(file);
				expect(readFileSync(file, "utf8")).toBe("original");
			}
		} finally {
			for (const file of [behaviorFile, jobsFile, memoryFile]) {
				rmSync(file, { force: true });
			}
		}
	});

	// B2: fork teardown skips the rollback wipe and the caller migrates state to
	// the forked session id — a second consecutive /rollback must still restore.
	it("migrateRollbackSession carries snapshots across a fork (two consecutive rollbacks)", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const sidA = `fork-old-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const sidB = `fork-new-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		rollback.initRollback(mockSM as SettingsManager, sidA);
		rollback.enableRollbackForSession(sidA);

		const f1 = join(testDir, "f1.ts");
		writeFileSync(f1, "v1");
		rollback.beginTurn(testDir, sidA);
		rollback.rollbackSnapshotBeforeWrite(f1, sidA);
		writeFileSync(f1, "v1-modified");

		const f2 = join(testDir, "f2.ts");
		writeFileSync(f2, "v2");
		rollback.beginTurn(testDir, sidA);
		rollback.rollbackSnapshotBeforeWrite(f2, sidA);
		writeFileSync(f2, "v2-modified");

		// Simulate the fork: rebind inits the new session id (empty dir), then the
		// /rollback handler migrates the old session's surviving state over.
		rollback.initRollback(mockSM as SettingsManager, sidB);
		rollback.enableRollbackForSession(sidB);
		rollback.migrateRollbackSession(sidA, sidB);

		expect(rollback.getRollbackStatus(sidA).turns).toBe(0);
		expect(rollback.getRollbackStatus(sidB).turns).toBe(2);

		const r1 = rollback.rollbackLastTurn(sidB);
		expect(r1.restored).toContain(f2);
		expect(readFileSync(f2, "utf8")).toBe("v2");
		const r2 = rollback.rollbackLastTurn(sidB);
		expect(r2.restored).toContain(f1);
		expect(readFileSync(f1, "utf8")).toBe("v1");

		rollback.clearRollback(sidB);
	});

	// B2: a session switch (/new, /sessions) still wipes the replaced session's
	// rollback state — but only that session's.
	it("clearRollback(sessionId) wipes only that session's state", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const sidA = `clear-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const sidB = `clear-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		rollback.initRollback(mockSM as SettingsManager, sidA);
		rollback.enableRollbackForSession(sidA);
		rollback.beginTurn(undefined, sidA);
		const fileA = join(testDir, "clear-a.ts");
		writeFileSync(fileA, "A");
		rollback.rollbackSnapshotBeforeWrite(fileA, sidA);

		rollback.initRollback(mockSM as SettingsManager, sidB);
		rollback.enableRollbackForSession(sidB);
		rollback.beginTurn(undefined, sidB);
		const fileB = join(testDir, "clear-b.ts");
		writeFileSync(fileB, "B");
		rollback.rollbackSnapshotBeforeWrite(fileB, sidB);

		rollback.clearRollback(sidA);
		expect(rollback.getRollbackStatus(sidA).turns).toBe(0);
		expect(rollback.getRollbackStatus(sidB).turns).toBe(1);
		rollback.clearRollback(sidB);
	});

	// B3: empty (chat-only) turns on top of the newest non-empty turn count
	// toward how far the conversation must rewind.
	it("reports turnsConsumed including skipped empty turns", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackTurns = () => 5; // keep all three turns (default 2 would prune the non-empty one)
		const filePath = join(testDir, "consumed.ts");
		writeFileSync(filePath, "original");

		rollback.beginTurn();
		rollback.rollbackSnapshotBeforeWrite(filePath);
		writeFileSync(filePath, "modified");

		rollback.beginTurn(); // chat-only turn
		rollback.beginTurn(); // another chat-only turn

		expect(rollback.peekRollbackTurnsConsumed()).toBe(3);
		const result = rollback.rollbackLastTurn();
		expect(result.turnsConsumed).toBe(3);
		expect(result.restored).toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original");
		expect(rollback.peekRollbackTurnsConsumed()).toBe(0);
	});

	// B5: Windows drive-letter/directory casing differs by launch context.
	it.skipIf(process.platform !== "win32")("root check is case-insensitive on Windows", async () => {
		const rollback = await import("../src/core/rollback.ts");
		const filePath = join(testDir, "case.ts");
		writeFileSync(filePath, "original");

		const flippedCwd = testDir.replace(/^([a-zA-Z]):/, (_m, drive: string) =>
			drive === drive.toUpperCase() ? `${drive.toLowerCase()}:` : `${drive.toUpperCase()}:`,
		);
		expect(flippedCwd).not.toBe(testDir);

		rollback.beginTurn(flippedCwd);
		rollback.rollbackSnapshotBeforeWrite(filePath);
		writeFileSync(filePath, "modified");

		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("original");
	});

	// B6: a staged rename (git sees "R") must revert both halves.
	it.skipIf(!hasGit)("tree scope undoes staged renames (mv a b + git add)", async () => {
		const rollback = await import("../src/core/rollback.ts");
		mockSM.getRollbackScope = () => "tree";
		mockSM.getRollbackCapture = () => "hybrid";
		initGitRepo(testDir);

		const a = join(testDir, "a.txt");
		const b = join(testDir, "b.txt");
		writeFileSync(a, "original");
		spawnSync("git", ["add", "."], { cwd: testDir });
		spawnSync("git", ["commit", "-m", "init"], { cwd: testDir });

		rollback.beginTurn(testDir); // baseline: clean tree
		renameSync(a, b); // bash: mv a b
		spawnSync("git", ["add", "-A"], { cwd: testDir }); // staged → porcelain reports "R"
		rollback.captureTreeChanges(testDir);

		const result = rollback.rollbackLastTurn();
		expect(result.restored).toContain(a);
		expect(result.deleted).toContain(b);
		expect(readFileSync(a, "utf8")).toBe("original");
		expect(existsSync(b)).toBe(false);
	});

	// B8: the external-modification warning is per session context, not per process.
	it("external-path warning fires once per session context", async () => {
		const rollback = await import("../src/core/rollback.ts");
		let warnings = 0;
		rollback.setRollbackWarningHandler(() => {
			warnings++;
		});
		const outside = join(tmpdir(), `rollback-b8-${Date.now()}.txt`);
		try {
			for (const sid of ["warn-a", "warn-b"]) {
				writeFileSync(outside, "outside");
				rollback.initRollback(mockSM as SettingsManager, sid);
				rollback.enableRollbackForSession(sid);
				rollback.beginTurn(testDir, sid);
				rollback.rollbackSnapshotBeforeWrite(outside, sid);
				writeFileSync(outside, "modified");
				rollback.rollbackLastTurn(sid);
			}
			expect(warnings).toBe(2);
		} finally {
			rollback.setRollbackWarningHandler(undefined);
			rmSync(outside, { force: true });
			rollback.clearRollback();
		}
	});

	// B9: a turn auto-started by a mid-turn snapshot inherits the last known cwd,
	// so the root check still constrains what it can restore.
	it("auto-started turns reuse the last cwd for the root check", async () => {
		const rollback = await import("../src/core/rollback.ts");
		rollback.beginTurn(testDir); // records lastCwd on the context
		rollback.rollbackLastTurn(); // consume the empty turn — turns list now empty

		const outside = join(tmpdir(), `rollback-b9-${Date.now()}.txt`);
		writeFileSync(outside, "outside");
		try {
			// Snapshot without an explicit beginTurn — auto-starts a turn.
			rollback.rollbackSnapshotBeforeWrite(outside);
			writeFileSync(outside, "modified");

			const result = rollback.rollbackLastTurn();
			expect(result.restored).not.toContain(outside);
			expect(readFileSync(outside, "utf8")).toBe("modified");
		} finally {
			rmSync(outside, { force: true });
		}
	});
});
