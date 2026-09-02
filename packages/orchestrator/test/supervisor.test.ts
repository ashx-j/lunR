import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadiusPresence } from "../src/radius.ts";
import { OrchestratorSupervisor, type RadiusClient, type RpcProcessHandle } from "../src/supervisor.ts";
import type { InstanceRecord } from "../src/types.ts";

class FakeRpcProcess implements RpcProcessHandle {
	disposed = false;
	private uiRequestHandler?: (request: RpcExtensionUIRequest) => void;
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();

	async send(command: RpcCommand): Promise<RpcResponse> {
		if (command.type === "prompt") {
			this.uiRequestHandler?.({
				type: "extension_ui_request",
				id: `ui-${Math.random()}`,
				method: "confirm",
				title: "Approve",
				message: "Continue?",
			});
		}
		if (command.type === "get_state") {
			return {
				type: "response",
				id: command.id ?? "state",
				command: "get_state",
				success: true,
				data: { sessionId: "session-1" },
			} as RpcResponse;
		}
		return {
			type: "response",
			id: command.id ?? "response",
			command: command.type,
			success: true,
		} as RpcResponse;
	}

	handleUiResponse(_response: RpcExtensionUIResponse): void {}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

const originalEnvironment = {
	orchestratorDir: process.env.PI_ORCHESTRATOR_DIR,
	agentDir: process.env.PI_CODING_AGENT_DIR,
	radiusKey: process.env.RADIUS_API_KEY,
	radiusTimeout: process.env.PI_RADIUS_REQUEST_TIMEOUT_MS,
};

describe("OrchestratorSupervisor reliability", () => {
	let directory: string;

	beforeEach(() => {
		directory = join(tmpdir(), `lunr-orchestrator-supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		process.env.PI_ORCHESTRATOR_DIR = directory;
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
	});

	afterEach(() => {
		for (const [key, value] of Object.entries({
			PI_ORCHESTRATOR_DIR: originalEnvironment.orchestratorDir,
			PI_CODING_AGENT_DIR: originalEnvironment.agentDir,
			RADIUS_API_KEY: originalEnvironment.radiusKey,
			PI_RADIUS_REQUEST_TIMEOUT_MS: originalEnvironment.radiusTimeout,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("rejects a second RPC stream without stealing the first stream's UI requests", async () => {
		const rpc = new FakeRpcProcess();
		const radius: RadiusClient = {
			registerPi: async (instance) => instance,
			disconnectPi: async () => {},
		};
		const supervisor = new OrchestratorSupervisor({ createRpcProcess: () => rpc, radius });
		const instance = await supervisor.spawnInstance({ cwd: directory });
		const streamARequests: RpcExtensionUIRequest[] = [];
		const streamBRequests: RpcExtensionUIRequest[] = [];
		const streamA = supervisor.openRpcStream(
			instance.id,
			() => {},
			(request) => streamARequests.push(request),
		);
		expect(streamA).toBeDefined();
		expect(() =>
			supervisor.openRpcStream(
				instance.id,
				() => {},
				(request) => streamBRequests.push(request),
			),
		).toThrow("already has an active RPC stream");

		await streamA?.handleRpc({ type: "prompt", message: "first" });
		await streamA?.handleRpc({ type: "prompt", message: "second" });
		expect(streamARequests).toHaveLength(2);
		expect(streamBRequests).toHaveLength(0);

		streamA?.close();
		const streamB = supervisor.openRpcStream(
			instance.id,
			() => {},
			(request) => streamBRequests.push(request),
		);
		await streamB?.handleRpc({ type: "prompt", message: "third" });
		expect(streamBRequests).toHaveLength(1);
		streamB?.close();
		await supervisor.stopInstance(instance.id);
	});

	it("bounds Radius spawn and stop calls while disposing local RPC processes", async () => {
		process.env.RADIUS_API_KEY = "test-key";
		process.env.PI_RADIUS_REQUEST_TIMEOUT_MS = "25";
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => {})),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const spawnRpc = new FakeRpcProcess();
		const spawnRadius = new RadiusPresence();
		const spawnSupervisor = new OrchestratorSupervisor({
			createRpcProcess: () => spawnRpc,
			radius: {
				registerPi: async () => {
					await spawnRadius.start();
					throw new Error("unreachable");
				},
				disconnectPi: async () => {},
			},
		});
		const spawnStartedAt = Date.now();
		await expect(spawnSupervisor.spawnInstance({ cwd: directory })).rejects.toThrow("timed out");
		expect(Date.now() - spawnStartedAt).toBeLessThan(500);
		expect(spawnRpc.disposed).toBe(true);

		const stopRpc = new FakeRpcProcess();
		const stopRadius = new RadiusPresence();
		const stopClient: RadiusClient = {
			registerPi: async (instance): Promise<InstanceRecord> => ({ ...instance, radiusPiId: "radius-pi-1" }),
			disconnectPi: (instance) => stopRadius.disconnectPi(instance),
		};
		const stopSupervisor = new OrchestratorSupervisor({ createRpcProcess: () => stopRpc, radius: stopClient });
		const instance = await stopSupervisor.spawnInstance({ cwd: directory });
		const stopStartedAt = Date.now();
		await expect(stopSupervisor.stopInstance(instance.id)).resolves.toMatchObject({ status: "stopped" });
		expect(Date.now() - stopStartedAt).toBeLessThan(500);
		expect(stopRpc.disposed).toBe(true);
	});
});
