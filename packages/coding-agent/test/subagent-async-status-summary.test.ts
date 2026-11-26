import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { summarizeAsyncStatus } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-status.ts";

let asyncDir: string | undefined;

afterEach(() => {
	if (asyncDir) rmSync(asyncDir, { recursive: true, force: true });
	asyncDir = undefined;
});

it("keeps each step's session file in the async run summary", () => {
	asyncDir = mkdtempSync(join(tmpdir(), "lunr-async-summary-"));
	const summary = summarizeAsyncStatus(asyncDir, {
		runId: "run-1",
		mode: "chain",
		state: "running",
		startedAt: 1,
		steps: [
			{ agent: "first", status: "complete", sessionFile: "/sessions/first.jsonl" },
			{ agent: "second", status: "running" },
		],
	});
	expect(summary.steps.map((step) => step.sessionFile)).toEqual(["/sessions/first.jsonl", undefined]);
});
