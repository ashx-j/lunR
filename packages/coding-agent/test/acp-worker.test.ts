import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallGate } from "../src/core/agent-session.ts";
import type { PermissionMode } from "../src/core/permissions.ts";
import { ACP_SETTINGS_OVERRIDES } from "../src/modes/acp/policy.ts";
import type { RpcAcpPermissionRequest } from "../src/modes/rpc/rpc-types.ts";

const ACP_ENV = "LUNR_ACP_WORKER_CONFIG";
let fixtureDir: string;

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv(ACP_ENV, undefined);
	fixtureDir = mkdtempSync(join(tmpdir(), "lunr-acp-worker-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(fixtureDir, { recursive: true, force: true });
});

function activate(mcpServers: unknown[] = []) {
	const configPath = join(fixtureDir, "worker.json");
	writeFileSync(configPath, JSON.stringify({ mcpServers }));
	vi.stubEnv(ACP_ENV, configPath);
	return configPath;
}

async function bridgeFixture(signal?: AbortSignal) {
	activate();
	const { createAcpWorkerBridge } = await import("../src/modes/acp/worker.ts");
	let gate: ToolCallGate | undefined;
	const removeGate = vi.fn();
	const output: RpcAcpPermissionRequest[] = [];
	const permissionState = { mode: "yolo" as PermissionMode };
	const setPermissionMode = vi.fn((mode: PermissionMode) => {
		permissionState.mode = mode;
	});
	const bridge = createAcpWorkerBridge(
		{
			sessionId: "acp-worker-test",
			agent: { signal },
			get permissionMode() {
				return permissionState.mode;
			},
			setPermissionMode,
			settingsManager: { getDefaultPermissionMode: () => "yolo" },
			addToolCallGate(nextGate) {
				gate = nextGate;
				return removeGate;
			},
		},
		(event) => output.push(event),
	);
	if (!bridge || !gate) throw new Error("Worker bridge was not installed.");
	return { bridge, gate, output, removeGate, permissionState, setPermissionMode };
}

describe("ACP rpc worker", () => {
	it("keeps normal rpc sessions unchanged", async () => {
		const { createAcpWorkerBridge } = await import("../src/modes/acp/worker.ts");
		const addToolCallGate = vi.fn();
		expect(createAcpWorkerBridge({ sessionId: "ordinary", addToolCallGate }, vi.fn())).toBeUndefined();
		expect(addToolCallGate).not.toHaveBeenCalled();
	});

	it("waits before writes and distinguishes approval from denial", async () => {
		const { bridge, gate, output } = await bridgeFixture();
		const write = gate("write", { path: "file.ts", content: "new" }, "write-call");
		expect(output[0]).toMatchObject({ type: "acp_permission_request", toolCallId: "write-call", toolName: "write" });
		bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: false });
		await expect(write).resolves.toMatchObject({ block: true, reason: "Tool execution denied by ACP client." });
		const edit = gate("edit", { path: "file.ts" }, "edit-call");
		bridge.respond({ type: "extension_ui_response", id: output[1].id, confirmed: true });
		await expect(edit).resolves.toBeUndefined();
		await expect(gate("read", { path: "file.ts" }, "read-call")).resolves.toBeUndefined();
		expect(output).toHaveLength(2);
		bridge.dispose();
	});

	it("requests permission for unknown tools and explains delegated authorization", async () => {
		const { bridge, gate, output } = await bridgeFixture();
		const delegated = gate("subagent", { task: "edit", permissions: "full" }, "delegation-call");
		expect(output[0].description).toContain("authorizes the child's tools");
		bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: true });
		await expect(delegated).resolves.toBeUndefined();
		const unknown = gate("t3_update", {}, "mcp-call");
		bridge.respond({ type: "extension_ui_response", id: output[1].id, cancelled: true });
		await expect(unknown).resolves.toMatchObject({ block: true });
		bridge.dispose();
	});

	it("unblocks all approvals on cancellation and rejects stale responses", async () => {
		const { bridge, gate, output, removeGate } = await bridgeFixture();
		const first = gate("bash", { command: "task" }, "first");
		const second = gate("write", {}, "second");
		bridge.cancel();
		await expect(first).resolves.toMatchObject({ block: true, reason: "ACP request cancelled." });
		await expect(second).resolves.toMatchObject({ block: true });
		expect(bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: true })).toBe(false);
		await expect(gate("write", {}, "after-cancel")).resolves.toMatchObject({ block: true });
		bridge.beginTurn();
		const next = gate("write", {}, "next-turn");
		bridge.respond({ type: "extension_ui_response", id: output[2].id, confirmed: true });
		await expect(next).resolves.toBeUndefined();
		bridge.dispose();
		expect(removeGate).toHaveBeenCalledOnce();
	});

	it("releases approvals when lunr aborts internally", async () => {
		const controller = new AbortController();
		const { bridge, gate, output } = await bridgeFixture(controller.signal);
		const pending = gate("write", {}, "internally-aborted");
		controller.abort();
		await expect(pending).resolves.toMatchObject({ block: true });
		expect(bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: true })).toBe(false);
		bridge.dispose();
	});

	it("routes plan and aggregate launch approvals through the host", async () => {
		const { bridge, output } = await bridgeFixture();
		const { requestPlanApproval, gateToolCall } = await import("../src/core/permissions.ts");
		const plan = requestPlanApproval("implement the feature");
		expect(output[0]).toMatchObject({ toolName: "present_plan", input: { kind: "plan" } });
		bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: false });
		expect(await plan).toContain("Plan declined");
		const launches = gateToolCall(
			"subagent",
			{ tasks: Array.from({ length: 3 }, (_, index) => ({ task: `task ${index}`, description: `child ${index}` })) },
			fixtureDir,
		);
		expect(output[1]).toMatchObject({ toolName: "subagent", input: { kind: "large-subagent-launch" } });
		bridge.cancel();
		expect(await launches).toMatchObject({ block: true });
		bridge.dispose();
	});

	it("validates permission modes and refuses active session changes", async () => {
		const { setRpcPermissionMode } = await import("../src/modes/acp/worker.ts");
		const setPermissionMode = vi.fn<(mode: PermissionMode) => void>();
		const session = { isIdle: true, isCompacting: false, isRetrying: false, isBashRunning: false, setPermissionMode };
		for (const mode of ["yolo", "auto", "read-only"]) setRpcPermissionMode(session, mode);
		expect(setPermissionMode).toHaveBeenCalledTimes(3);
		expect(() => setRpcPermissionMode(session, "manual")).toThrow("Invalid permission mode");
		expect(() => setRpcPermissionMode({ ...session, isIdle: false }, "yolo")).toThrow("session is active");
		expect(() => setRpcPermissionMode({ ...session, isBashRunning: true }, "auto")).toThrow("session is active");
	});

	it("restores writable mode only after plan approval", async () => {
		const { bridge, output, permissionState, setPermissionMode } = await bridgeFixture();
		const { requestPlanApproval } = await import("../src/core/permissions.ts");
		permissionState.mode = "auto";
		bridge.permissionModeChanged();
		permissionState.mode = "read-only";
		const rejected = requestPlanApproval("a concrete plan");
		bridge.respond({ type: "extension_ui_response", id: output[0].id, confirmed: false });
		await rejected;
		expect(permissionState.mode).toBe("read-only");
		const accepted = requestPlanApproval("a concrete plan");
		bridge.respond({ type: "extension_ui_response", id: output[1].id, confirmed: true });
		await accepted;
		expect(setPermissionMode).toHaveBeenCalledWith("auto");
		expect(permissionState.mode).toBe("auto");
		bridge.dispose();
	});

	it("retains pending child work after terminal state until notification delivery", async () => {
		const { bridge } = await bridgeFixture();
		const { registerSubagentCancellation } = await import("../src/core/subagent-cancellation.ts");
		let awaitingDelivery = true;
		const unregister = registerSubagentCancellation("acp-worker-test", {
			hasActiveRuns: () => false,
			hasPendingWork: () => awaitingDelivery,
			stop: async () => ({ requested: 0, failed: 0 }),
		});
		expect(bridge.hasPendingWork()).toBe(true);
		awaitingDelivery = false;
		expect(bridge.hasPendingWork()).toBe(false);
		unregister();
		bridge.dispose();
	});

	it("stops only the worker session's registered children", async () => {
		const { bridge } = await bridgeFixture();
		const { registerSubagentCancellation } = await import("../src/core/subagent-cancellation.ts");
		const stop = vi.fn(async () => ({ requested: 1, failed: 0 }));
		const otherStop = vi.fn(async () => ({ requested: 1, failed: 0 }));
		const unregister = registerSubagentCancellation("acp-worker-test", { hasActiveRuns: () => true, stop });
		const unregisterOther = registerSubagentCancellation("other-session", {
			hasActiveRuns: () => true,
			stop: otherStop,
		});
		await bridge.stopChildren();
		expect(stop).toHaveBeenCalledOnce();
		expect(otherStop).not.toHaveBeenCalled();
		unregister();
		unregisterOther();
		bridge.dispose();
	});
});

describe("ACP host MCP overlay", () => {
	it("retains the overlay for the worker and removes activation from child environments", async () => {
		activate([
			{ name: "t3", command: "node", args: ["mcp.js"], env: [{ name: "T3_TOKEN", value: "fixture-token" }] },
			{
				type: "http",
				name: "http-server",
				url: "http://localhost:1234/mcp",
				headers: [{ name: "Authorization", value: "fixture" }],
			},
			{ type: "sse", name: "sse-server", url: "http://localhost:1234/sse", headers: [] },
		]);
		const { createAcpWorkerBridge } = await import("../src/modes/acp/worker.ts");
		const bridge = createAcpWorkerBridge({ sessionId: "overlay-test", addToolCallGate: () => () => {} }, vi.fn());
		expect(process.env[ACP_ENV]).toBeUndefined();
		const { readAcpWorkerConfig, acpMcpServerOverlay } = await import("../src/modes/acp/worker-config.ts");
		const config = readAcpWorkerConfig();
		if (!config) throw new Error("Missing retained configuration.");
		const overlay = acpMcpServerOverlay(config);
		expect(overlay.t3).toMatchObject({ command: "node", args: ["mcp.js"], env: { T3_TOKEN: "fixture-token" } });
		expect(overlay["http-server"]).toMatchObject({
			url: "http://localhost:1234/mcp",
			headers: { Authorization: "fixture" },
			auth: false,
		});
		expect(overlay["sse-server"]).toMatchObject({ url: "http://localhost:1234/sse" });
		bridge?.dispose();
	});

	it("replaces colliding local servers without persisting host credentials", async () => {
		activate([{ name: "local", command: "host-command", args: [], env: [] }]);
		const localConfig = join(fixtureDir, "local-mcp.json");
		const original = JSON.stringify({
			mcpServers: { local: { url: "http://localhost/old" }, preserved: { command: "existing" } },
		});
		writeFileSync(localConfig, original);
		const { loadMcpConfig } = await import("../src/builtin-extensions/pi-mcp-adapter/config.ts");
		const config = loadMcpConfig(localConfig, fixtureDir, false);
		expect(config.mcpServers.local).toMatchObject({ command: "host-command" });
		expect(config.mcpServers.local.url).toBeUndefined();
		expect(config.mcpServers.preserved.command).toBe("existing");
		expect(readFileSync(localConfig, "utf8")).toBe(original);
	});

	it("fails closed on malformed host configuration", async () => {
		const { parseAcpWorkerConfig } = await import("../src/modes/acp/worker-config.ts");
		expect(() =>
			parseAcpWorkerConfig({ mcpServers: [{ name: "x", command: "node", args: [1], env: [] }] }),
		).toThrow();
		expect(() =>
			parseAcpWorkerConfig({ mcpServers: [{ name: "x", type: "http", url: "file:///tmp/config", headers: [] }] }),
		).toThrow();
		expect(() =>
			parseAcpWorkerConfig({
				mcpServers: [
					{ name: "x", command: "node", args: [], env: [] },
					{ name: "x", command: "node", args: [], env: [] },
				],
			}),
		).toThrow("unique");
	});

	it("keeps discovered host metadata inside the disposable worker directory", async () => {
		activate();
		const { getMetadataCachePath, saveMetadataCache, loadMetadataCache } = await import(
			"../src/builtin-extensions/pi-mcp-adapter/metadata-cache.ts"
		);
		expect(getMetadataCachePath()).toBe(join(fixtureDir, "mcp-cache.json"));
		const cache = { version: 1, servers: { t3: { configHash: "fixture", tools: [], resources: [], cachedAt: 123 } } };
		saveMetadataCache(cache);
		expect(loadMetadataCache()).toEqual(cache);
	});
});

describe("ACP session-only settings", () => {
	it("copies trusted scopes and keeps changes across reload without persisting", async () => {
		const { SettingsManager } = await import("../src/core/settings-manager.ts");
		const agentDir = join(fixtureDir, "agent");
		const projectDir = join(fixtureDir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".lunr"), { recursive: true });
		const globalPath = join(agentDir, "settings.json");
		const projectPath = join(projectDir, ".lunr", "settings.json");
		const conflictingSettings = {
			browserEnabled: true,
			automaticSubagentDelegation: true,
			defaultPermissionMode: "auto",
		};
		const originalGlobal = JSON.stringify({
			...conflictingSettings,
			defaultProvider: "existing",
			defaultModel: "original",
		});
		const originalProject = JSON.stringify({ ...conflictingSettings, defaultThinkingLevel: "low" });
		writeFileSync(globalPath, originalGlobal);
		writeFileSync(projectPath, originalProject);
		const settings = SettingsManager.create(projectDir, agentDir, {
			projectTrusted: false,
			sessionOnly: true,
			runtimeOverrides: ACP_SETTINGS_OVERRIDES,
		});
		const expectPolicy = () => {
			expect(settings.getBrowserEnabled()).toBe(false);
			expect(settings.getAutomaticSubagentDelegation()).toBe(false);
			expect(settings.getDefaultPermissionMode()).toBe("yolo");
		};
		expectPolicy();
		expect(settings.getProjectSettings()).toEqual({});
		settings.setProjectTrusted(true);
		expect(settings.getDefaultThinkingLevel()).toBe("low");
		expectPolicy();
		settings.setDefaultModelAndProvider("acp-fixture", "test");
		settings.setBrowserEnabled(true);
		settings.setAutomaticSubagentDelegation(true);
		settings.setDefaultPermissionMode("auto");
		expectPolicy();
		await settings.flush();
		await settings.reload();
		expectPolicy();
		settings.applyOverrides({
			browserEnabled: true,
			automaticSubagentDelegation: true,
			defaultPermissionMode: "auto",
		});
		expectPolicy();
		settings.setProjectTrusted(false);
		expectPolicy();
		const terminal = SettingsManager.create(projectDir, agentDir);
		expect(terminal.getBrowserEnabled()).toBe(true);
		expect(terminal.getAutomaticSubagentDelegation()).toBe(true);
		expect(terminal.getDefaultPermissionMode()).toBe("auto");
		expect(settings.getDefaultProvider()).toBe("acp-fixture");
		expect(settings.getDefaultModel()).toBe("test");
		expect(readFileSync(globalPath, "utf8")).toBe(originalGlobal);
		expect(readFileSync(projectPath, "utf8")).toBe(originalProject);
	});

	it("retains malformed-scope diagnostics without overwriting the original", async () => {
		const { SettingsManager } = await import("../src/core/settings-manager.ts");
		const path = join(fixtureDir, "settings.json");
		writeFileSync(path, "malformed settings sentinel");
		const settings = SettingsManager.create(fixtureDir, fixtureDir, { sessionOnly: true });
		expect(settings.drainErrors()).toMatchObject([{ scope: "global" }]);
		settings.setDefaultThinkingLevel("high");
		await settings.flush();
		expect(readFileSync(path, "utf8")).toBe("malformed settings sentinel");
	});
});

describe("ACP subagent completion delivery", () => {
	it("keeps batched completions pending until dispatch and suppresses cancelled continuation", async () => {
		const { createEventBus } = await import("../src/core/event-bus.ts");
		const { default: registerSubagentNotify } = await import(
			"../src/builtin-extensions/pi-subagents/src/runs/background/notify.ts"
		);
		const { SUBAGENT_ASYNC_COMPLETE_EVENT } = await import(
			"../src/builtin-extensions/pi-subagents/src/shared/types.ts"
		);
		const events = createEventBus();
		const sendMessage = vi.fn();
		const dispatched: string[] = [];
		const timers = new Map<number, () => void>();
		let timerId = 0;
		let allowContinuation = true;
		const dispose = registerSubagentNotify(
			{ events, sendMessage },
			{ currentSessionId: "delivery-fixture" },
			{
				onDelivered: (id) => {
					expect(sendMessage).toHaveBeenCalled();
					dispatched.push(id);
				},
				canTriggerTurn: () => allowContinuation,
				timers: {
					setTimeout(handler) {
						const id = ++timerId;
						timers.set(id, handler);
						return id;
					},
					clearTimeout(handle) {
						if (typeof handle === "number") timers.delete(handle);
					},
				},
			},
		);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "child-complete",
			sessionId: "delivery-fixture",
			success: true,
			summary: "completed output",
			agent: "child",
			timestamp: 1,
		});
		expect(dispose.hasPendingCompletions()).toBe(true);
		expect(dispatched).toEqual([]);
		expect(sendMessage).not.toHaveBeenCalled();
		const callback = timers.values().next().value;
		if (!callback) throw new Error("Missing completion timer.");
		callback();
		expect(dispose.hasPendingCompletions()).toBe(false);
		expect(dispatched).toEqual(["child-complete"]);
		expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
		allowContinuation = false;
		let finishStop: (() => void) | undefined;
		const stopping = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "child-completed-during-stop",
			sessionId: "delivery-fixture",
			success: true,
			summary: "completed while stop awaits its launch barrier",
			agent: "child",
			timestamp: 2,
		});
		const duringStop = timers.values().next().value;
		if (!duringStop) throw new Error("Missing completion timer during cancellation.");
		duringStop();
		expect(sendMessage.mock.calls[1][1]).toEqual({ triggerTurn: false });
		if (!finishStop) throw new Error("Missing delayed stop resolver.");
		finishStop();
		await stopping;
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "cancelled-child",
			sessionId: "delivery-fixture",
			success: false,
			state: "failed",
			summary: "completion raced cancellation",
			agent: "child",
			timestamp: 2,
		});
		expect(sendMessage.mock.calls[2][1]).toEqual({ triggerTurn: false });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "discarded-child",
			sessionId: "delivery-fixture",
			success: true,
			summary: "held completion",
			agent: "child",
			timestamp: 3,
		});
		expect(dispose.hasPendingCompletions()).toBe(true);
		dispose.discardPending();
		expect(dispose.hasPendingCompletions()).toBe(false);
		expect(sendMessage).toHaveBeenCalledTimes(3);
		dispose();
		events.clear();
	});
});
