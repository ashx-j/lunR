import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../src/core/cron/jobs.ts";
import {
	gateToolCall,
	getPermissionMode,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
} from "../src/core/permissions.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";
import { startGatewayCron } from "../src/gateway/cron.ts";

const state = vi.hoisted(() => ({
	run: undefined as undefined | ((prompt: string, job: CronJob) => Promise<string>),
	sessions: [] as Array<{ id: string; order: string[] }>,
	bindFailure: false,
	next: 0,
}));
vi.mock("../src/core/cron/scheduler.ts", () => ({
	startScheduler: (options: { runJob: typeof state.run }) => {
		state.run = options.runJob;
		return { stop() {} };
	},
}));
vi.mock("../src/builtin-extensions/index.ts", () => ({ loadAllBuiltinExtensions: async () => [] }));
vi.mock("../src/core/customize.ts", () => ({ registerCustomizeBridge() {} }));
vi.mock("../src/core/memory-cap.ts", () => ({ registerMemoryCapBridge() {} }));
vi.mock("../src/core/model-tiers.ts", () => ({ registerModelTierBridge() {} }));
vi.mock("../src/core/runtime-bridges.ts", () => ({ bindRuntimeBridges() {} }));
vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: { create: () => ({ getDefaultPermissionMode: () => "manual" }) },
}));
vi.mock("../src/core/session-manager.ts", () => ({
	SessionManager: {
		inMemory: () => {
			const id = `factory-${++state.next}`;
			return { getSessionId: () => id };
		},
	},
}));
vi.mock("../src/core/agent-session-services.ts", () => ({
	createAgentSessionServices: async () => ({}),
	createAgentSessionFromServices: async ({ sessionManager }: { sessionManager: { getSessionId(): string } }) => {
		const record = { id: sessionManager.getSessionId(), order: [] as string[] };
		state.sessions.push(record);
		return {
			session: {
				state: { messages: [{ role: "assistant", content: [{ type: "text", text: "blocked" }] }] },
				bindExtensions: async () => {
					record.order.push(`bind:${getPermissionMode(record.id)}`);
					if (state.bindFailure) throw new Error("partial bind");
				},
				prompt: async () => {
					record.order.push(
						`prompt:${Boolean((await gateToolCall("computer_observe", {}, ".", record.id))?.block)}`,
					);
				},
				extensionRunner: {
					hasHandlers: () => true,
					emit: async () => {
						record.order.push(`shutdown:${getPermissionMode(record.id)}`);
					},
				},
				dispose: () => {
					record.order.push(`dispose:${getPermissionMode(record.id)}`);
				},
			},
		};
	},
}));

afterEach(() => {
	resetAllPermissionContexts();
	registerApprovalHandler(undefined);
	state.sessions.length = 0;
	state.bindFailure = false;
});

describe("native computer gateway cron factory", () => {
	it("binds each fresh session with isolated approvals and removes its context after shutdown", async () => {
		resetPermissions("auto");
		const approve = vi.fn(async () => "session" as const);
		registerApprovalHandler(approve);
		const scheduler = startGatewayCron({ adapters: new Map(), cfg: {} as GatewayConfig, fallbackModels: [] });
		for (let index = 0; index < 2; index++)
			await state.run?.("observe relevant GUI", { id: `job-${index}` } as CronJob);
		expect(state.sessions).toHaveLength(2);
		expect(state.sessions[0].id).not.toBe(state.sessions[1].id);
		for (const session of state.sessions)
			expect(session.order).toEqual(["bind:manual", "prompt:true", "shutdown:manual", "dispose:auto"]);
		expect(approve).not.toHaveBeenCalled();
		scheduler.stop();
	});
	it("shuts down partially bound extensions before deleting the failed session context", async () => {
		resetPermissions("auto");
		state.bindFailure = true;
		const scheduler = startGatewayCron({ adapters: new Map(), cfg: {} as GatewayConfig, fallbackModels: [] });
		await expect(state.run?.("task", { id: "job-failed" } as CronJob)).rejects.toThrow("partial bind");
		expect(state.sessions[0].order).toEqual(["bind:manual", "shutdown:manual", "dispose:auto"]);
		scheduler.stop();
	});
});
