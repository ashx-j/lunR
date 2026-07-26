import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";

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
		rollback.initRollback(mockSM as SettingsManager, "test-session");
		rollback.clearRollback();
		rollback.enableRollbackForSession();
	});

	afterEach(async () => {
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

	it("getRollbackStatus reports state", async () => {
		const rollback = await import("../src/core/rollback.ts");
		rollback.beginTurn();
		const filePath = join(testDir, "status.ts");
		writeFileSync(filePath, "content");
		rollback.rollbackSnapshotBeforeWrite(filePath);

		const status = rollback.getRollbackStatus();
		expect(status.enabled).toBe(true);
		expect(status.turns).toBeGreaterThanOrEqual(1);
		expect(status.files).toBeGreaterThanOrEqual(1);
	});
});
