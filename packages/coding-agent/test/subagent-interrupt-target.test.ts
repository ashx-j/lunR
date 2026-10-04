import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentExecutor } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

const { reconcile, interrupt, stop } = vi.hoisted(() => ({ reconcile: vi.fn(), interrupt: vi.fn(), stop: vi.fn() }));
vi.mock(
	"../src/builtin-extensions/pi-subagents/src/runs/background/stale-run-reconciler.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/builtin-extensions/pi-subagents/src/runs/background/stale-run-reconciler.ts")
		>()),
		reconcileAsyncRun: reconcile,
	}),
);
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/background/control-channel.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/builtin-extensions/pi-subagents/src/runs/background/control-channel.ts")
	>()),
	deliverInterruptRequest: interrupt,
	deliverStopRequest: stop,
}));
const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lunr-interrupt-target-"));
	roots.push(root);
	const state = {
		currentSessionId: "parent",
		asyncJobs: new Map([
			["owned-job", { asyncId: "owned-job", asyncDir: root, status: "running", updatedAt: 1, sessionId: "parent" }],
		]),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		fleetJobs: new Map(),
	} as unknown as SubagentState;
	reconcile.mockReturnValue({ status: { state: "running", pid: 1234, sessionId: "parent" } });
	const executor = createSubagentExecutor({
		pi: {} as never,
		state,
		config: {} as never,
		tempArtifactsDir: root,
		getSubagentSessionRoot: () => root,
		expandTilde: (value) => value,
	});
	return (id?: string) =>
		executor.execute(
			"test-call",
			{ action: "interrupt", ...(id !== undefined ? { id } : {}) },
			new AbortController().signal,
			undefined,
			{ cwd: root } as never,
		);
}

describe("interrupt targeting", () => {
	it.each(["missing-job-id", "", " "])("fails explicit id %j without touching the newest running job", async (id) => {
		const execute = fixture();
		expect(await execute(id)).toMatchObject({ isError: true });
		expect(interrupt).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("leaves an explicitly named run belonging to another session untouched", async () => {
		const execute = fixture();
		reconcile.mockReturnValue({ status: { state: "running", pid: 1234, sessionId: "other-parent" } });
		expect(await execute("owned-job")).toMatchObject({ isError: true });
		expect(interrupt).not.toHaveBeenCalled();
	});

	it("retains newest-job selection when the id is omitted", async () => {
		const execute = fixture();
		expect(await execute()).not.toMatchObject({ isError: true });
		expect(interrupt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pid: 1234 }));
	});
});
