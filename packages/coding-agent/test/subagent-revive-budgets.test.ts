import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeAsyncSingle } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
	createSubagentExecutor,
	type SubagentParamsLike,
} from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { appendTurnBudgetSystemPrompt } from "../src/builtin-extensions/pi-subagents/src/runs/shared/turn-budget.ts";
import { ASYNC_DIR, type SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

// A revive starts the child through executeAsyncSingle; record the budgets it receives.
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts")
		>();
	return {
		...actual,
		isAsyncAvailable: () => true,
		executeAsyncSingle: vi.fn((id: string) => ({
			content: [{ type: "text", text: "started" }],
			details: { mode: "single", results: [], asyncId: id },
		})),
	};
});

let root: string;
const runDirs: string[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lunr-revive-budgets-"));
	for (const key of Object.keys(process.env)) {
		if (/^PI_(SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(key)) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
	for (const dir of runDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A finished async run with a persisted child session, which a revive needs.
function finishedRun(): string {
	// Revive only reads run directories under the async root.
	const runDir = join(ASYNC_DIR, `revive-${process.pid}-${Date.now()}`);
	runDirs.push(runDir);
	mkdirSync(runDir, { recursive: true });
	const sessionFile = join(root, "child.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "child", cwd: root })}\n`);
	writeFileSync(
		join(runDir, "status.json"),
		JSON.stringify({
			runId: basename(runDir),
			mode: "single",
			state: "complete",
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			cwd: root,
			steps: [
				{
					agent: "child",
					description: "Child",
					status: "complete",
					sessionFile,
					modelSelection: { kind: "tier", tier: "light" },
				},
			],
		}),
	);
	return runDir;
}

function revive(params: Partial<SubagentParamsLike>) {
	const executor = createSubagentExecutor({
		pi: { getSessionName: () => "parent", events: { emit() {}, on() {} } } as never,
		state: {
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
		} as unknown as SubagentState,
		config: { intercomBridge: { mode: "off" } } as never,
		tempArtifactsDir: root,
		getSubagentSessionRoot: () => root,
		expandTilde: (value) => value,
	});
	return executor.execute(
		"call",
		{ action: "resume", dir: finishedRun(), message: "go on", ...params },
		undefined,
		undefined,
		{
			cwd: root,
			hasUI: false,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent" },
		} as never,
	);
}

it("gives a revived child the default grace turn", async () => {
	const result = await revive({ turnBudget: { maxTurns: 5 } });
	expect(result.isError).not.toBe(true);
	const options = vi.mocked(executeAsyncSingle).mock.calls[0]?.[1];
	expect(options).toMatchObject({ turnBudget: { maxTurns: 5, graceTurns: 1 } });
	expect(appendTurnBudgetSystemPrompt("", options?.turnBudget)).toContain(
		"1 additional assistant turn may be allowed",
	);
});

it("rejects an invalid turn budget before reviving", async () => {
	const result = await revive({ turnBudget: { maxTurns: 0 } });
	expect(result).toMatchObject({ isError: true, content: [{ text: "turnBudget.maxTurns must be an integer >= 1." }] });
	expect(executeAsyncSingle).not.toHaveBeenCalled();
});
