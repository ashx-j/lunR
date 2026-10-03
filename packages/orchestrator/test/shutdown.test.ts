import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RADIUS_REQUEST_TIMEOUT_MS, RadiusPresence, radiusPresence } from "../src/radius.ts";
import { RPC_KILL_CONFIRM_MS, RPC_TERMINATE_GRACE_MS, RpcProcessInstance } from "../src/rpc-process.ts";
import { loadInstances, saveInstances } from "../src/storage.ts";
import { OrchestratorSupervisor } from "../src/supervisor.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: () => undefined }));
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	isBunBinary: true,
}));

class FakeChild extends EventEmitter {
	pid = 12345;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	onSignal: (signal: NodeJS.Signals) => void = () => this.emit("exit", 0, null);
	kill = vi.fn((signal: NodeJS.Signals) => {
		this.onSignal(signal);
		return true;
	});

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			const command = JSON.parse(chunk.toString()) as { id: string; type: string };
			this.stdout.write(
				`${JSON.stringify({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
					data: { sessionId: "fake-session" },
				})}\n`,
			);
		});
	}
}

let profile: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
	vi.useFakeTimers();
	profile = mkdtempSync(join(tmpdir(), "lunr-orchestrator-shutdown-"));
	for (const name of Object.keys(process.env)) {
		if (/^PI_(?:SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(name)) vi.stubEnv(name, undefined);
	}
	vi.stubEnv("HOME", profile);
	vi.stubEnv("PI_ORCHESTRATOR_DIR", profile);
	vi.stubEnv("RADIUS_API_KEY", "fake-test-key");
	vi.stubEnv("PI_RADIUS_ORCHESTRATOR_URL", "https://example.invalid/v1/");
	fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected fake transport call"));
	vi.stubGlobal("fetch", fetchMock);
	spawn.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(profile, { recursive: true, force: true });
});

function createRpc(child = new FakeChild()) {
	spawn.mockReturnValueOnce(child as unknown as ChildProcess);
	return { child, rpc: new RpcProcessInstance({ cwd: profile }) };
}

function fakeRadius() {
	vi.spyOn(radiusPresence, "registerPi").mockImplementation(async (instance) => ({
		...instance,
		radiusPiId: `radius-${instance.id}`,
	}));
	return vi.spyOn(radiusPresence, "disconnectPi").mockResolvedValue();
}

describe("owned RPC termination", () => {
	it("observes synchronous exit without waiting for the grace deadline", async () => {
		const { child, rpc } = createRpc();
		await rpc.dispose();
		expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("escalates an ignored SIGTERM and confirms SIGKILL exit", async () => {
		const { child, rpc } = createRpc();
		child.onSignal = (signal) => {
			if (signal === "SIGKILL") child.emit("exit", null, signal);
		};
		const first = rpc.dispose();
		expect(rpc.dispose()).toBe(first);
		expect(() => rpc.send({ type: "get_state" })).toThrow("not running");
		await vi.advanceTimersByTimeAsync(RPC_TERMINATE_GRACE_MS);
		await first;
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects unconfirmed termination within both deadlines and permits retry", async () => {
		const { child, rpc } = createRpc();
		child.onSignal = () => {};
		const result = expect(rpc.dispose()).rejects.toThrow("termination unconfirmed");
		await vi.advanceTimersByTimeAsync(RPC_TERMINATE_GRACE_MS + RPC_KILL_CONFIRM_MS);
		await result;
		expect(child.listenerCount("exit")).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		child.onSignal = () => child.emit("exit", 0, null);
		await rpc.dispose();
	});

	it.each(["false", "throw", "error"] as const)(
		"does not treat a %s kill outcome as confirmed exit",
		async (outcome) => {
			const { child, rpc } = createRpc();
			child.kill.mockImplementation(() => {
				if (outcome === "throw") throw new Error("kill denied");
				if (outcome === "error") child.emit("error", new Error("kill denied"));
				return outcome !== "false";
			});
			const result = expect(rpc.dispose()).rejects.toThrow("termination unconfirmed");
			await vi.advanceTimersByTimeAsync(RPC_TERMINATE_GRACE_MS + RPC_KILL_CONFIRM_MS);
			await result;
			expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("supervisor cleanup", () => {
	it("disposes every child despite Radius failure and retries retained remote cleanup", async () => {
		const disconnect = fakeRadius();
		disconnect.mockRejectedValueOnce(new Error("Radius unavailable"));
		const supervisor = new OrchestratorSupervisor();
		const first = new FakeChild();
		spawn.mockReturnValueOnce(first as unknown as ChildProcess);
		const one = await supervisor.spawnInstance({ cwd: profile });
		const secondChild = new FakeChild();
		spawn.mockReturnValueOnce(secondChild as unknown as ChildProcess);
		const two = await supervisor.spawnInstance({ cwd: profile });
		await expect(supervisor.shutdown()).rejects.toThrow("shutdown cleanup failed");
		expect(first.kill).toHaveBeenCalledWith("SIGTERM");
		expect(secondChild.kill).toHaveBeenCalledWith("SIGTERM");
		expect(supervisor.getLiveInstance(one.id)).toMatchObject({ status: "error", radiusPiId: one.radiusPiId });
		expect(supervisor.getLiveInstance(two.id)).toBeUndefined();
		expect(loadInstances()).toHaveLength(1);
		await supervisor.stopInstance(one.id);
		expect(loadInstances()).toEqual([]);
	});

	it("cleans an ordinary child while retaining and reporting an unconfirmed survivor", async () => {
		fakeRadius();
		const supervisor = new OrchestratorSupervisor();
		const survivor = new FakeChild();
		survivor.onSignal = () => {};
		spawn.mockReturnValueOnce(survivor as unknown as ChildProcess);
		const one = await supervisor.spawnInstance({ cwd: profile });
		const ordinary = new FakeChild();
		spawn.mockReturnValueOnce(ordinary as unknown as ChildProcess);
		const two = await supervisor.spawnInstance({ cwd: profile });
		const result = expect(supervisor.shutdown()).rejects.toThrow("shutdown cleanup failed");
		await vi.advanceTimersByTimeAsync(RPC_TERMINATE_GRACE_MS + RPC_KILL_CONFIRM_MS);
		await result;
		expect(ordinary.kill).toHaveBeenCalledWith("SIGTERM");
		expect(supervisor.getLiveInstance(two.id)).toBeUndefined();
		expect(supervisor.getLiveInstance(one.id)).toMatchObject({ status: "error", pid: survivor.pid });
		expect(loadInstances()).toMatchObject([{ id: one.id, status: "error", pid: survivor.pid }]);
		expect(
			supervisor.openRpcStream(
				one.id,
				() => {},
				() => {},
			),
		).toBeUndefined();
		await expect(supervisor.spawnInstance({ cwd: profile })).rejects.toThrow("shutting down");
		survivor.onSignal = () => survivor.emit("exit", 0, null);
		await supervisor.stopInstance(one.id);
		expect(loadInstances()).toEqual([]);
	});

	it("bounds a stalled Radius disconnect while still terminating the child", async () => {
		fakeRadius().mockImplementation(() => new Promise(() => {}));
		const supervisor = new OrchestratorSupervisor();
		const child = new FakeChild();
		spawn.mockReturnValueOnce(child as unknown as ChildProcess);
		const record = await supervisor.spawnInstance({ cwd: profile });
		const result = expect(supervisor.stopInstance(record.id)).rejects.toThrow("cleanup failed");
		await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		await result;
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(supervisor.getLiveInstance(record.id)?.status).toBe("error");
	});

	it("retains a failed-spawn child when termination remains unconfirmed", async () => {
		fakeRadius();
		vi.spyOn(radiusPresence, "registerPi").mockRejectedValue(new Error("registration failed"));
		const supervisor = new OrchestratorSupervisor();
		const child = new FakeChild();
		child.onSignal = () => {};
		spawn.mockReturnValueOnce(child as unknown as ChildProcess);
		const result = expect(supervisor.spawnInstance({ cwd: profile })).rejects.toThrow("spawn and cleanup failed");
		await vi.advanceTimersByTimeAsync(RPC_TERMINATE_GRACE_MS + RPC_KILL_CONFIRM_MS);
		await result;
		expect(supervisor.listLiveInstances()).toMatchObject([{ status: "error", pid: child.pid }]);
	});
	it("awaits an in-flight registration during shutdown and cleans the returned remote ID", async () => {
		const disconnect = fakeRadius();
		let finishRegistration!: (instance: import("../src/types.ts").InstanceRecord) => void;
		vi.spyOn(radiusPresence, "registerPi").mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRegistration = resolve;
				}),
		);
		const supervisor = new OrchestratorSupervisor();
		const child = new FakeChild();
		spawn.mockReturnValueOnce(child as unknown as ChildProcess);
		const spawnResult = expect(supervisor.spawnInstance({ cwd: profile })).rejects.toThrow("stopped during spawn");
		await vi.advanceTimersByTimeAsync(0);
		const record = supervisor.listLiveInstances()[0];
		const shutdown = supervisor.shutdown();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		finishRegistration({ ...record, radiusPiId: "late-registration" });
		await Promise.all([shutdown, spawnResult]);
		expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ radiusPiId: "late-registration" }));
		expect(supervisor.listLiveInstances()).toEqual([]);
		expect(loadInstances()).toEqual([]);
	});

	it("attempts every restart disconnect and retains unconfirmed saved PIDs", async () => {
		const disconnect = fakeRadius().mockRejectedValueOnce(new Error("Radius unavailable"));
		saveInstances([
			{ id: "one", cwd: profile, status: "online", pid: 111, radiusPiId: "remote-one", createdAt: "now" },
			{ id: "two", cwd: profile, status: "online", radiusPiId: "remote-two", createdAt: "now" },
		]);
		await expect(new OrchestratorSupervisor().recoverAfterRestart()).rejects.toThrow("restart cleanup failed");
		expect(disconnect).toHaveBeenCalledTimes(2);
		expect(loadInstances()).toMatchObject([
			{
				id: "one",
				status: "error",
				pid: 111,
				radiusPiId: "remote-one",
				cleanupError: "RPC exit unconfirmed after orchestrator restart",
			},
			{ id: "two", status: "stopped" },
		]);
		expect(loadInstances()[1].radiusPiId).toBeUndefined();
	});
});

describe("Radius request deadlines", () => {
	it("aborts a stalled disconnect and clears its timer", async () => {
		fetchMock.mockImplementation(() => new Promise(() => {}));
		const presence = new RadiusPresence();
		const result = expect(
			presence.disconnectPi({
				id: "child",
				radiusPiId: "remote-child",
				cwd: profile,
				status: "online",
				createdAt: "now",
			}),
		).rejects.toThrow("timed out");
		const signal = fetchMock.mock.calls[0][1]?.signal;
		await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		await result;
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a stalled error response body and still ignores HTTP 404", async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: () => new Promise(() => {}) } as Response);
		const presence = new RadiusPresence();
		const instance = { id: "child", radiusPiId: "remote", cwd: profile, status: "online", createdAt: "now" } as const;
		const result = expect(presence.disconnectPi(instance)).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		await result;
		fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
		await presence.disconnectPi(instance);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not restart a heartbeat after stop while its request is pending", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ id: "machine", heartbeatIntervalMs: 10, expiresInMs: 100 }));
		const presence = new RadiusPresence();
		await presence.start();
		let finishHeartbeat!: (response: Response) => void;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishHeartbeat = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(10);
		fetchMock.mockResolvedValueOnce(Response.json({}));
		await presence.stop();
		finishHeartbeat(new Response("gone", { status: 404 }));
		await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});
});
