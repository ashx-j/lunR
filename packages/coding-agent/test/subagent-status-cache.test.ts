import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomicJson } from "../src/builtin-extensions/pi-subagents/src/shared/atomic-json.ts";
import type { AsyncStatus } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { readStatus } from "../src/builtin-extensions/pi-subagents/src/shared/utils.ts";

const temps: string[] = [];
const fixedTime = new Date("2026-01-01T00:00:00.000Z");

afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("async status cache", () => {
	it.each([false, true])("refreshes equal-mtime status after atomic replacement, deletion=%s", (deleted) => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-status-cache-"));
		temps.push(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		const running: AsyncStatus = {
			runId: "cache-test",
			state: "running",
			mode: "single",
			startedAt: fixedTime.getTime(),
			steps: [],
		};
		writeAtomicJson(statusPath, running);
		fs.utimesSync(statusPath, fixedTime, fixedTime);
		const originalStat = fs.statSync(statusPath);
		const cached = readStatus(asyncDir);
		expect(cached?.state).toBe("running");
		expect(readStatus(asyncDir)).toBe(cached);

		if (deleted) {
			fs.unlinkSync(statusPath);
			expect(readStatus(asyncDir)).toBeNull();
		}
		writeAtomicJson(statusPath, { ...running, state: "stopped" });
		fs.utimesSync(statusPath, fixedTime, fixedTime);
		const replacementStat = fs.statSync(statusPath);
		expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);
		expect(replacementStat.size).toBe(originalStat.size);
		expect(readStatus(asyncDir)?.state).toBe("stopped");
	});
});
