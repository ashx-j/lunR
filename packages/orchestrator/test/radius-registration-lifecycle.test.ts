import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RADIUS_REQUEST_TIMEOUT_MS, RadiusPresence, radiusPresence } from "../src/radius.ts";
import { loadInstances, loadMachine } from "../src/storage.ts";
import { OrchestratorSupervisor } from "../src/supervisor.ts";
import type { InstanceRecord } from "../src/types.ts";

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
	sessionId = "initial-session";
	kill = vi.fn(() => {
		this.emit("exit", 0, null);
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
					data: { sessionId: this.sessionId },
				})}\n`,
			);
		});
	}
}
interface PendingResponse {
	signal?: AbortSignal | null;
	finish(response: Response): void;
}
let profile: string;
let supervisor: OrchestratorSupervisor;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let pending: PendingResponse[];
let machineCount: number;
let piCount: number;
let machineInterval: number;
let piInterval: number;
let holdMachineAfter: number;
let holdPiAfter: number;
const extraPresences: RadiusPresence[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	profile = mkdtempSync(join(tmpdir(), "lunr-radius-lifecycle-"));
	for (const name of Object.keys(process.env)) {
		if (/^PI_(?:SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(name)) vi.stubEnv(name, undefined);
	}
	vi.stubEnv("HOME", profile);
	vi.stubEnv("USERPROFILE", profile);
	vi.stubEnv("PI_ORCHESTRATOR_DIR", profile);
	vi.stubEnv("RADIUS_API_KEY", "inert-test-key");
	vi.stubEnv("PI_RADIUS_ORCHESTRATOR_URL", "https://example.invalid/v1/");
	spawn.mockReset();
	pending = [];
	machineCount = piCount = 0;
	machineInterval = 100_000;
	piInterval = 10;
	holdMachineAfter = holdPiAfter = 1;
	fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
		const parsed = new URL(String(url));
		expect(parsed.hostname).toBe("example.invalid");
		const path = parsed.pathname;
		if (path.endsWith("machines/register")) {
			machineCount += 1;
			if (machineCount <= holdMachineAfter) return registration(`machine-${machineCount}`, machineInterval);
		} else if (path.endsWith("pis/register")) {
			piCount += 1;
			if (piCount <= holdPiAfter) return registration(`remote-${piCount}`, piInterval);
		} else if (path.endsWith("/heartbeat")) {
			return new Response("gone", { status: 404 });
		} else if (path.endsWith("/disconnect")) {
			return Response.json({});
		} else throw new Error(`Unexpected inert HTTP path ${path}`);
		return new Promise<Response>((resolve) => pending.push({ signal: options?.signal, finish: resolve }));
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
	supervisor = new OrchestratorSupervisor();
	radiusPresence.setCoordinator({
		getLiveInstance: (id) => supervisor.getLiveInstance(id),
		listLiveInstances: () => supervisor.listLiveInstances(),
		updateInstance: (record) => supervisor.updateInstance(record),
	});
});

afterEach(async () => {
	await Promise.allSettled([supervisor.shutdown(), radiusPresence.stop(), ...extraPresences.map((p) => p.stop())]);
	for (const response of pending) response.finish(registration("after-test-late", 10));
	await vi.advanceTimersByTimeAsync(0);
	await Promise.allSettled([radiusPresence.stop(), ...extraPresences.splice(0).map((p) => p.stop())]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(profile, { recursive: true, force: true });
});
function registration(id: string, intervalMs = 10) {
	return Response.json({ id, heartbeatIntervalMs: intervalMs, expiresInMs: 100_000 });
}
function calls(path: string) {
	return fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(path));
}
async function startChild() {
	await radiusPresence.start();
	const child = new FakeChild();
	spawn.mockReturnValueOnce(child as unknown as ChildProcess);
	const record = await supervisor.spawnInstance({ cwd: profile, label: "original-label" });
	return { child, record };
}
async function recoveringChild() {
	const result = await startChild();
	await vi.advanceTimersByTimeAsync(30);
	expect(pending).toHaveLength(1);
	return { ...result, recovery: pending[0] };
}
function newPresence() {
	const presence = new RadiusPresence();
	extraPresences.push(presence);
	return presence;
}
function instance(): InstanceRecord {
	return { id: "owned", cwd: profile, status: "online", createdAt: "original", pid: 12345 };
}

describe("Radius heartbeat recovery ownership", () => {
	it.each(["individual stop", "shutdown"] as const)(
		"disconnects late recovery after %s without restoring a saved instance",
		async (mode) => {
			const { child, record, recovery } = await recoveringChild();
			if (mode === "shutdown") await Promise.all([supervisor.shutdown(), radiusPresence.stop()]);
			else await supervisor.stopInstance(record.id);
			expect(recovery.signal?.aborted).toBe(true);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(supervisor.listLiveInstances()).toEqual([]);
			expect(loadInstances()).toEqual([]);
			recovery.finish(registration("late-remote"));
			await vi.advanceTimersByTimeAsync(0);
			expect(calls("pis/late-remote/disconnect")).toHaveLength(1);
			expect(supervisor.listLiveInstances()).toEqual([]);
			expect(loadInstances()).toEqual([]);
			if (mode === "shutdown") expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("retains newer session metadata when current-owner recovery succeeds", async () => {
		const { child, record, recovery } = await recoveringChild();
		child.sessionId = "newer-session";
		await supervisor.handleRpc(record.id, { type: "new_session" });
		recovery.finish(registration("recovered-remote"));
		await vi.advanceTimersByTimeAsync(0);
		expect(supervisor.getLiveInstance(record.id)).toMatchObject({
			status: "online",
			radiusPiId: "recovered-remote",
			sessionId: "newer-session",
			label: "original-label",
			pid: child.pid,
		});
		expect(calls("pis/recovered-remote/disconnect")).toHaveLength(0);
	});

	it("does not upsert an absent owner or replace stopping lifecycle fields", async () => {
		const { record, recovery } = await recoveringChild();
		const stopping = supervisor.stopInstance(record.id);
		supervisor.updateInstance({ ...record, radiusPiId: "stale-remote", sessionId: "stale-session" });
		expect(supervisor.getLiveInstance(record.id)?.status).toBe("stopping");
		await stopping;
		supervisor.updateInstance({ ...record, radiusPiId: "stale-remote" });
		expect(loadInstances()).toEqual([]);
		recovery.finish(registration("late-remote"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loadInstances()).toEqual([]);
	});

	it.each(["remote-3", "distinct-late"])(
		"preserves a replacement when the old canceled response returns %s",
		async (lateId) => {
			const { record, recovery } = await recoveringChild();
			await supervisor.stopInstance(record.id);
			holdPiAfter = 3;
			const replacementChild = new FakeChild();
			spawn.mockReturnValueOnce(replacementChild as unknown as ChildProcess);
			const replacement = await supervisor.spawnInstance({ cwd: profile });
			expect(replacement.radiusPiId).toBe("remote-3");
			recovery.finish(registration(lateId));
			await vi.advanceTimersByTimeAsync(0);
			expect(calls("pis/remote-3/disconnect")).toHaveLength(0);
			if (lateId !== "remote-3") expect(calls(`pis/${lateId}/disconnect`)).toHaveLength(1);
			expect(supervisor.getLiveInstance(replacement.id)).toMatchObject({ status: "online", radiusPiId: "remote-3" });
		},
	);

	it("reports a failed late disconnect and retains its ID for a bounded cleanup retry", async () => {
		const { recovery } = await recoveringChild();
		await Promise.all([supervisor.shutdown(), radiusPresence.stop()]);
		fetchMock.mockResolvedValueOnce(new Response("inert disconnect failure", { status: 503 }));
		recovery.finish(registration("failed-late-remote"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls("pis/failed-late-remote/disconnect")).toHaveLength(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("pis/failed-late-remote cleanup failed"));
		await radiusPresence.stop();
		expect(calls("pis/failed-late-remote/disconnect")).toHaveLength(2);
		expect(loadInstances()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans late success after the recovery request deadline and can retry normally", async () => {
		const { record, recovery } = await recoveringChild();
		await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		expect(recovery.signal?.aborted).toBe(true);
		recovery.finish(registration("timed-out-remote"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls("pis/timed-out-remote/disconnect")).toHaveLength(1);
		expect(supervisor.getLiveInstance(record.id)?.radiusPiId).toBe("remote-1");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(pending.length).toBeGreaterThan(1);
		pending[1].finish(registration("retry-remote"));
		await vi.advanceTimersByTimeAsync(0);
		expect(supervisor.getLiveInstance(record.id)?.radiusPiId).toBe("retry-remote");
	});
});

describe("Radius initial and machine registration ownership", () => {
	it("cancels machine recovery on stop and disposes its late ID without installing timers or saving it", async () => {
		machineInterval = 10;
		piInterval = 100_000;
		await startChild();
		await vi.advanceTimersByTimeAsync(30);
		expect(pending).toHaveLength(1);
		const recovery = pending[0];
		await Promise.all([supervisor.shutdown(), radiusPresence.stop()]);
		expect(recovery.signal?.aborted).toBe(true);
		recovery.finish(registration("late-machine"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loadMachine()?.id).toBe("machine-1");
		expect(calls("machines/late-machine/disconnect")).toHaveLength(1);
		expect(piCount).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["stop", "timeout"] as const)("disposes initial Pi registration arriving after %s", async (reason) => {
		const presence = newPresence();
		await presence.start();
		holdPiAfter = 0;
		const pendingRegistration = presence.registerPi(instance());
		const rejected = expect(pendingRegistration).rejects.toThrow(reason === "stop" ? "stopped" : "timed out");
		if (reason === "stop") await presence.stop();
		else await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		await rejected;
		expect(pending[0].signal?.aborted).toBe(true);
		pending[0].finish(registration("late-initial-pi"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls("pis/late-initial-pi/disconnect")).toHaveLength(1);
		await presence.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["stop", "timeout"] as const)("disposes initial machine registration arriving after %s", async (reason) => {
		const presence = newPresence();
		holdMachineAfter = 0;
		const starting = presence.start();
		const rejected = expect(starting).rejects.toThrow(reason === "stop" ? "stopped" : "timed out");
		if (reason === "stop") await presence.stop();
		else await vi.advanceTimersByTimeAsync(RADIUS_REQUEST_TIMEOUT_MS);
		await rejected;
		expect(pending[0].signal?.aborted).toBe(true);
		pending[0].finish(registration("late-initial-machine"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loadMachine()).toBeUndefined();
		expect(calls("machines/late-initial-machine/disconnect")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves a restarted presence's reused machine ID when an old response arrives", async () => {
		const presence = newPresence();
		holdMachineAfter = 0;
		const oldStart = expect(presence.start()).rejects.toThrow("stopped");
		await presence.stop();
		await oldStart;
		holdMachineAfter = 2;
		const replacement = await presence.start();
		expect(replacement?.id).toBe("machine-2");
		pending[0].finish(registration("machine-2"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls("machines/machine-2/disconnect")).toHaveLength(0);
		expect(loadMachine()?.id).toBe("machine-2");
	});
});
