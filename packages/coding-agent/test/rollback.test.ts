import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SettingsManager } from "../src/core/settings-manager.ts";

// We test the rollback module directly with a mock settings manager.
// The module is stateful, so we import it dynamically.

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