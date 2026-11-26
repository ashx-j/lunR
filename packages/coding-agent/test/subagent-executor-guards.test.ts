import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createSubagentExecutor,
	type SubagentParamsLike,
} from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function execute(params: SubagentParamsLike) {
	const root = mkdtempSync(join(tmpdir(), "lunr-executor-guards-"));
	roots.push(root);
	const state = {
		currentSessionId: "parent",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		fleetJobs: new Map(),
	} as unknown as SubagentState;
	const executor = createSubagentExecutor({
		pi: {} as never,
		state,
		config: {} as never,
		tempArtifactsDir: root,
		getSubagentSessionRoot: () => root,
		expandTilde: (value) => value,
	});
	return executor.execute("test-call", params, undefined, undefined, { cwd: root } as never);
}

it("rejects tasks next to an append-step chain", async () => {
	const result = await execute({
		action: "append-step",
		id: "run-1",
		chain: [{ task: "next", description: "Next step", tier: "light" }],
		tasks: [{ task: "other", description: "Other", tier: "light" }],
	});
	expect(result).toMatchObject({
		isError: true,
		content: [{ text: "action='append-step' takes chain only, not tasks." }],
	});
});

it("validates a turn budget passed to a resume", async () => {
	const result = await execute({ action: "resume", id: "run-1", message: "go on", turnBudget: { maxTurns: 0 } });
	expect(result).toMatchObject({ isError: true, content: [{ text: "turnBudget.maxTurns must be an integer >= 1." }] });
});
