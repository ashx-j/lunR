import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { normalizeChildSpec } from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { resetPermissions } from "../src/core/permissions.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn,
}));

let root: string;
beforeEach(() => {
	vi.useFakeTimers();
	root = mkdtempSync(`${tmpdir()}/lunr-child-cancel-`);
	resetPermissions("auto");
	for (const key of Object.keys(process.env)) {
		if (/^PI_(SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(key)) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	resetPermissions();
	rmSync(root, { recursive: true, force: true });
});

function child() {
	const proc = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: false,
		kill: vi.fn((signal: string) => {
			proc.killed = true;
			if (signal === "SIGKILL") close();
			return true;
		}),
	});
	function close() {
		proc.emit("exit", null, "SIGKILL");
		proc.stdout.end();
		proc.stderr.end();
		proc.emit("close", null, "SIGKILL");
	}
	spawn.mockReturnValue(proc);
	return { proc, close };
}

function run(signal?: AbortSignal, interruptSignal?: AbortSignal) {
	return runSync(
		root,
		normalizeChildSpec(
			{
				task: "Read the scratch file.",
				description: "Read scratch",
				permissions: "read-only",
				model: "test/model",
			},
			{ runId: "cancel-test", index: 0, parentMode: "auto" },
		),
		{
			runId: "cancel-test",
			cwd: root,
			signal,
			interruptSignal,
			communicationEnabled: false,
			artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
			acceptance: false,
		},
	);
}

describe("foreground child cancellation", () => {
	it("escalates after delivered SIGTERM when the child has not exited", async () => {
		const { proc } = child();
		const controller = new AbortController();
		const result = run(controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		expect(proc.killed).toBe(true);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		await vi.advanceTimersByTimeAsync(3000);
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		await result;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears escalation when that child exits before its stdio closes", async () => {
		const { proc, close } = child();
		const controller = new AbortController();
		const result = run(controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		proc.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(3000);
		expect(proc.kill.mock.calls).toEqual([["SIGTERM"]]);
		close();
		await result;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("also bounds an explicit interrupt of a non-cooperative child", async () => {
		const { proc } = child();
		const controller = new AbortController();
		const result = run(undefined, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(4000);
		expect(proc.kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"], ["SIGKILL"]]);
		expect(await result).toMatchObject({ interrupted: true });
		expect(vi.getTimerCount()).toBe(0);
	});
});
