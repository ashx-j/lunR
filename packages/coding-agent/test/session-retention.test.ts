import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOldSessions } from "../src/core/session-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function writeSessionFile(dir: string, name: string, ageDays: number, now: number): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, "{}\n");
	const mtime = new Date(now - ageDays * DAY_MS);
	utimesSync(filePath, mtime, mtime);
	return filePath;
}

describe("pruneOldSessions", () => {
	let root: string;
	const now = Date.now();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-session-retention-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("deletes .jsonl files older than the retention window in project subdirs", async () => {
		const projectDir = join(root, "--proj--");
		mkdirSync(projectDir);
		const oldFile = writeSessionFile(projectDir, "old_1.jsonl", 45, now);
		const newFile = writeSessionFile(projectDir, "new_1.jsonl", 5, now);

		const { deleted } = await pruneOldSessions(root, 30, { now });

		expect(deleted).toEqual([oldFile]);
		expect(existsSync(oldFile)).toBe(false);
		expect(existsSync(newFile)).toBe(true);
	});

	it("covers flat session dirs (custom --session-dir layout)", async () => {
		const oldFile = writeSessionFile(root, "old_flat.jsonl", 90, now);
		const newFile = writeSessionFile(root, "new_flat.jsonl", 1, now);

		const { deleted } = await pruneOldSessions(root, 30, { now });

		expect(deleted).toEqual([oldFile]);
		expect(existsSync(newFile)).toBe(true);
	});

	it("ignores non-jsonl files and nested content inside project dirs", async () => {
		const projectDir = join(root, "--proj--");
		mkdirSync(projectDir);
		const oldJsonl = writeSessionFile(projectDir, "old.jsonl", 45, now);
		writeSessionFile(projectDir, "notes.txt", 45, now);

		const { deleted } = await pruneOldSessions(root, 30, { now });

		expect(deleted).toEqual([oldJsonl]);
		expect(existsSync(join(projectDir, "notes.txt"))).toBe(true);
	});

	it("never deletes the excluded active session file", async () => {
		const projectDir = join(root, "--proj--");
		mkdirSync(projectDir);
		const activeFile = writeSessionFile(projectDir, "active.jsonl", 365, now);

		const { deleted } = await pruneOldSessions(root, 30, { now, excludeFile: activeFile });

		expect(deleted).toEqual([]);
		expect(existsSync(activeFile)).toBe(true);
	});

	it("retention 0 keeps everything", async () => {
		const projectDir = join(root, "--proj--");
		mkdirSync(projectDir);
		const oldFile = writeSessionFile(projectDir, "old.jsonl", 1000, now);

		const { deleted } = await pruneOldSessions(root, 0, { now });

		expect(deleted).toEqual([]);
		expect(existsSync(oldFile)).toBe(true);
	});

	it("missing sessions root does not throw", async () => {
		const { deleted } = await pruneOldSessions(join(root, "does-not-exist"), 30, { now });
		expect(deleted).toEqual([]);
	});
});
