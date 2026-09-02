import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RpcProcessInstance } from "../src/rpc-process.ts";

function createFakeChild(kill: (signal?: NodeJS.Signals | number) => boolean): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		pid: 12345,
		kill,
	});
	return child;
}

describe("RpcProcessInstance disposal", () => {
	it("cannot miss an exit emitted synchronously by kill", async () => {
		let child: ChildProcess;
		child = createFakeChild(() => {
			Object.assign(child, { exitCode: 0 });
			child.emit("exit", 0, null);
			return true;
		});
		const forceKill = vi.fn();
		const rpc = new RpcProcessInstance({
			cwd: process.cwd(),
			childProcess: child,
			disposeGraceMs: 20,
			forceKillGraceMs: 20,
			forceKill,
		});

		await expect(rpc.dispose()).resolves.toBeUndefined();
		expect(forceKill).not.toHaveBeenCalled();
	});

	it("settles after escalating when a child ignores every signal", async () => {
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		const child = createFakeChild((signal) => {
			signals.push(signal);
			return true;
		});
		const rpc = new RpcProcessInstance({
			cwd: process.cwd(),
			childProcess: child,
			disposeGraceMs: 20,
			forceKillGraceMs: 20,
		});

		const startedAt = Date.now();
		const first = rpc.dispose();
		const second = rpc.dispose();
		expect(second).toBe(first);
		await first;
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
