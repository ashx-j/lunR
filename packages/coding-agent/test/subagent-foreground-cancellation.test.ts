import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { getSystemErrorMap } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { normalizeChildSpec } from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	type RunSyncOptions,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
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
		pid: 424242 as number | undefined,
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

function run(signal?: AbortSignal, interruptSignal?: AbortSignal, onUpdate?: RunSyncOptions["onUpdate"]) {
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
			onUpdate,
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

describe("foreground child signal errors", () => {
	it.each(["synchronous", "asynchronous", "throwing"] as const)(
		"preserves hard escalation after a %s post-spawn EPERM",
		async (mode) => {
			const { proc, close } = child();
			proc.kill.mockImplementation((signal: string) => {
				if (signal === "SIGTERM") {
					const emit = () => proc.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
					if (mode === "throwing") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
					if (mode === "synchronous") emit();
					else setTimeout(emit, 0);
					return false;
				}
				close();
				return true;
			});
			const controller = new AbortController();
			let settled = false;
			const pending = run(controller.signal).then((result) => {
				settled = true;
				return result;
			});
			try {
				await vi.advanceTimersByTimeAsync(0);
				controller.abort();
				await vi.advanceTimersByTimeAsync(0);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(2999);
				expect(proc.kill.mock.calls).toEqual([["SIGTERM"]]);
				await vi.advanceTimersByTimeAsync(1);
				expect(proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
				expect(await pending).toMatchObject({ exitCode: 1 });
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				close();
				await pending;
			}
		},
	);

	it.each(["abort", "interrupt"] as const)(
		"reports unconfirmed termination without releasing ownership after denied %s signals",
		async (kind) => {
			const { proc, close } = child();
			proc.kill.mockImplementation(() => {
				proc.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
				return false;
			});
			const controller = new AbortController();
			const update = vi.fn();
			let settled = false;
			const pending = run(
				kind === "abort" ? controller.signal : undefined,
				kind === "interrupt" ? controller.signal : undefined,
				update,
			).then((result) => {
				settled = true;
				return result;
			});
			try {
				await vi.advanceTimersByTimeAsync(0);
				controller.abort();
				await vi.advanceTimersByTimeAsync(10_000);
				expect(settled).toBe(false);
				expect(proc.stdout.destroyed).toBe(false);
				expect(proc.stderr.destroyed).toBe(false);
				expect(proc.kill.mock.calls).toEqual(
					kind === "abort" ? [["SIGTERM"], ["SIGKILL"]] : [["SIGINT"], ["SIGTERM"], ["SIGKILL"]],
				);
				const uncertain = update.mock.calls.filter(([value]) =>
					value.content[0].text.includes("termination unconfirmed"),
				);
				expect(uncertain).toHaveLength(1);
				expect(uncertain[0][0].details.results[0].progress.status).toBe("running");
				expect(uncertain[0][0].content[0].text).toContain("424242");
				await vi.advanceTimersByTimeAsync(10_000);
				expect(proc.kill.mock.calls).toHaveLength(kind === "abort" ? 2 : 3);
				close();
				await pending;
				expect(settled).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				close();
				await pending;
			}
		},
	);

	it("retains ownership if SIGKILL returns true but no exit arrives", async () => {
		const { proc, close } = child();
		proc.kill.mockImplementation(() => true);
		const controller = new AbortController();
		const update = vi.fn();
		let settled = false;
		const pending = run(controller.signal, undefined, update).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(settled).toBe(false);
			expect(update.mock.calls.some(([value]) => value.content[0].text.includes("termination unconfirmed"))).toBe(
				true,
			);
		} finally {
			close();
			await pending;
		}
	});

	it("uses Node's actual synchronous EPERM error path without signaling an OS process", async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const proc = Object.assign(new actual.ChildProcess(), {
			pid: 424242,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const originalHandle = Reflect.get(proc, "_handle") as { close(): void };
		originalHandle.close();
		const eperm = [...getSystemErrorMap()].find(([, [name]]) => name === "EPERM")![0];
		const handle = { kill: vi.fn(() => eperm) };
		Object.assign(proc, { _handle: handle });
		spawn.mockReturnValue(proc);
		const controller = new AbortController();
		const update = vi.fn();
		let settled = false;
		const pending = run(controller.signal, undefined, update).then((value) => {
			settled = true;
			return value;
		});
		const close = () => {
			proc.emit("exit", null, "SIGKILL");
			proc.stdout.end();
			proc.stderr.end();
			proc.emit("close", null, "SIGKILL");
		};
		try {
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(settled).toBe(false);
			expect(proc.killed).toBe(false);
			expect(handle.kill).toHaveBeenCalledTimes(2);
			expect(update.mock.calls.some(([value]) => value.details.results[0].error?.includes("EPERM"))).toBe(true);
			expect(
				update.mock.calls.filter(([value]) => value.content[0].text.includes("termination unconfirmed")),
			).toHaveLength(1);
		} finally {
			close();
			await pending;
		}
	});

	it("treats a received spawn event as ownership even if PID is unavailable", async () => {
		const { proc, close } = child();
		proc.pid = undefined;
		proc.kill.mockImplementation(() => {
			proc.emit("error", new Error("kill EPERM"));
			return false;
		});
		const controller = new AbortController();
		let settled = false;
		const pending = run(controller.signal).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			proc.emit("spawn");
			controller.abort();
			await vi.advanceTimersByTimeAsync(4000);
			expect(settled).toBe(false);
			expect(proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		} finally {
			close();
			await pending;
		}
	});

	it("clears uncertainty on close even when no exit event was observed", async () => {
		const { proc } = child();
		proc.kill.mockImplementation(() => false);
		const controller = new AbortController();
		const update = vi.fn();
		let settled = false;
		const pending = run(controller.signal, undefined, update).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBe(false);
		proc.stdout.end();
		proc.stderr.end();
		proc.emit("close", null, "SIGKILL");
		expect(await pending).toMatchObject({ exitCode: 1 });
		expect(settled).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect((await pending).progress?.error).not.toContain("termination unconfirmed");
	});

	it("keeps failed spawning terminal without a PID", async () => {
		const { proc } = child();
		proc.pid = undefined;
		const pending = run();
		await vi.advanceTimersByTimeAsync(0);
		proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
		expect(await pending).toMatchObject({ exitCode: 1, error: "spawn ENOENT" });
		expect(proc.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a denied cancellation and eventual close do not terminate another foreground child", async () => {
		const first = child();
		first.proc.kill.mockImplementation(() => false);
		const controller = new AbortController();
		let firstDone = false;
		const pending = run(controller.signal).then((value) => {
			firstDone = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(0);
		const second = child();
		let secondDone = false;
		const other = run().then((value) => {
			secondDone = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(firstDone).toBe(false);
			expect(secondDone).toBe(false);
			expect(second.proc.kill).not.toHaveBeenCalled();
			first.close();
			await pending;
			expect(secondDone).toBe(false);
			expect(second.proc.kill).not.toHaveBeenCalled();
			second.close();
			await other;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			first.close();
			second.close();
			await pending;
			await other;
		}
	});
});
