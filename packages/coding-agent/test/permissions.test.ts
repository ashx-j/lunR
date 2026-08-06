import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	clearSessionApprovals,
	createPermissionContext,
	deletePermissionContext,
	gateToolCall,
	getPermissionMode,
	NO_SWARM_HANDLER_REASON,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
	setPermissionMode,
} from "../src/core/permissions.ts";
import { effectiveSwarmCount, isExplicitSwarmTurn, SWARM_APPROVAL_THRESHOLD } from "../src/core/swarm.ts";

describe("permissions", () => {
	beforeEach(() => {
		resetAllPermissionContexts();
		resetPermissions("manual");
		registerApprovalHandler(undefined);
		clearSessionApprovals();
	});

	it("defaults to manual mode", () => {
		expect(getPermissionMode()).toBe("manual");
	});

	it("allows read-only tools in any mode", async () => {
		setPermissionMode("manual");
		const result = await gateToolCall("read", { path: "/foo" }, "/cwd");
		expect(result).toBeUndefined();
	});

	it("blocks mutating tools in manual mode when rejected", async () => {
		setPermissionMode("manual");
		registerApprovalHandler(async () => "reject" as ApprovalResponse);
		const result = await gateToolCall("bash", { command: "rm -rf /" }, "/cwd");
		expect(result).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
	});

	it("allows in manual mode when approved once", async () => {
		setPermissionMode("manual");
		registerApprovalHandler(async () => "once" as ApprovalResponse);
		const result = await gateToolCall("bash", { command: "ls" }, "/cwd");
		expect(result).toBeUndefined();
	});

	it("persists session approval across calls", async () => {
		setPermissionMode("manual");
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "session" as ApprovalResponse;
		});
		await gateToolCall("edit", { path: "/cwd/test.ts" }, "/cwd");
		expect(calls).toBe(1);
		const result = await gateToolCall("edit", { path: "/cwd/test2.ts" }, "/cwd");
		expect(result).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("allows all tools in yolo mode", async () => {
		setPermissionMode("yolo");
		const result = await gateToolCall("bash", { command: "rm -rf /" }, "/cwd");
		expect(result).toBeUndefined();
	});

	it("allows all tools in auto mode", async () => {
		setPermissionMode("auto");
		const result = await gateToolCall("write", { path: "/cwd/new.ts" }, "/cwd");
		expect(result).toBeUndefined();
	});

	it("blocks mutating tools in manual mode when no handler is registered (fail-closed)", async () => {
		setPermissionMode("manual");
		const result = await gateToolCall("bash", { command: "ls" }, "/cwd");
		expect(result).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
	});

	it("behavior_add triggers the approval dialog in manual mode", async () => {
		setPermissionMode("manual");
		let received: import("../src/core/permissions.ts").ApprovalRequest | undefined;
		registerApprovalHandler(async (req) => {
			received = req;
			return "once" as ApprovalResponse;
		});
		const result = await gateToolCall("behavior_add", { content: "always use strict types" }, "/cwd");
		expect(result).toBeUndefined();
		expect(received?.toolName).toBe("behavior_add");
		expect(received?.action).toBe("behavior_add");
		expect(received?.detail).toBe("always use strict types");
	});

	it("memory_add and cron are gated as mutating tools in manual mode", async () => {
		setPermissionMode("manual");
		registerApprovalHandler(async () => "reject" as ApprovalResponse);
		const memory = await gateToolCall("memory_add", { content: "user likes dark mode" }, "/cwd");
		expect(memory).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
		const cron = await gateToolCall("cron", { action: "create" }, "/cwd");
		expect(cron).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
	});

	it("resetPermissions restores default mode and clears approvals", async () => {
		setPermissionMode("auto");
		registerApprovalHandler(async () => "session" as ApprovalResponse);
		await gateToolCall("edit", { path: "/cwd/test.ts" }, "/cwd");
		resetPermissions("manual");
		expect(getPermissionMode()).toBe("manual");
		// session approvals should be cleared — handler must be called again
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "once" as ApprovalResponse;
		});
		await gateToolCall("edit", { path: "/cwd/test.ts" }, "/cwd");
		expect(calls).toBe(1);
	});

	it("edit-outside action for paths outside cwd", async () => {
		setPermissionMode("manual");
		let receivedAction = "";
		registerApprovalHandler(async (req) => {
			receivedAction = req.action;
			return "reject" as ApprovalResponse;
		});
		await gateToolCall("edit", { path: "/other/test.ts" }, "/cwd");
		expect(receivedAction).toBe("edit-outside");
	});

	it("isolates mode and approvals per session", async () => {
		createPermissionContext("session-a", "manual");
		createPermissionContext("session-b", "manual");

		expect(getPermissionMode("session-a")).toBe("manual");
		expect(getPermissionMode("session-b")).toBe("manual");

		// Session-b approval should not count for session-a.
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return (calls === 1 ? "session" : "reject") as ApprovalResponse;
		});
		await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd", "session-b");
		const aBlocked = await gateToolCall("edit", { path: "/cwd/b.ts" }, "/cwd", "session-a");
		expect(aBlocked).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });

		// Session-b should remain approved without calling the handler again.
		const bAllowed = await gateToolCall("edit", { path: "/cwd/c.ts" }, "/cwd", "session-b");
		expect(bAllowed).toBeUndefined();
		expect(calls).toBe(2);

		deletePermissionContext("session-a");
		deletePermissionContext("session-b");
	});
});

describe("swarm helpers", () => {
	it("counts parallel tasks with count multipliers", () => {
		expect(effectiveSwarmCount({ tasks: [{ agent: "a" }, { agent: "b" }] })).toBe(2);
		expect(effectiveSwarmCount({ tasks: [{ agent: "a", count: 3 }] })).toBe(3);
		expect(effectiveSwarmCount({ tasks: [{ agent: "a", count: 0 }, { agent: "b" }] })).toBe(2);
	});

	it("counts chain parallel fan-out blocks", () => {
		expect(
			effectiveSwarmCount({
				chain: [{ agent: "a" }, { parallel: [{ agent: "b" }, { agent: "c", count: 2 }] }],
			}),
		).toBe(3);
	});

	it("counts zero for single-agent and management calls", () => {
		expect(effectiveSwarmCount({ agent: "scout", task: "x" })).toBe(0);
		expect(effectiveSwarmCount({ action: "list" })).toBe(0);
		expect(effectiveSwarmCount({ chain: [{ agent: "a" }, { agent: "b" }] })).toBe(0);
	});

	it("detects explicit /swarm turns from the last user message", () => {
		const swarmBranch = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "[SWARM MODE] Task: x" }] } },
		];
		expect(isExplicitSwarmTurn(swarmBranch)).toBe(true);
		const plainBranch = [
			{ type: "message", message: { role: "user", content: "do something" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
		];
		expect(isExplicitSwarmTurn(plainBranch)).toBe(false);
		expect(isExplicitSwarmTurn([])).toBe(false);
	});
});

describe("agent-swarm gate", () => {
	const threeTasks = {
		tasks: [
			{ agent: "a", task: "one" },
			{ agent: "b", task: "two" },
			{ agent: "c", task: "three" },
		],
	};

	beforeEach(() => {
		resetAllPermissionContexts();
		resetPermissions("manual");
		registerApprovalHandler(undefined);
		clearSessionApprovals();
	});

	it("threshold is 2 parallel subagents", () => {
		expect(SWARM_APPROVAL_THRESHOLD).toBe(2);
	});

	it("allows subagent calls at or below the threshold without a handler", async () => {
		setPermissionMode("manual");
		expect(await gateToolCall("subagent", { agent: "scout", task: "x" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("subagent", { tasks: [{ agent: "a" }, { agent: "b" }] }, "/cwd")).toBeUndefined();
	});

	it("prompts for >2 parallel subagents in manual mode", async () => {
		setPermissionMode("manual");
		let received: ApprovalRequest | undefined;
		registerApprovalHandler(async (req) => {
			received = req;
			return "once" as ApprovalResponse;
		});
		const result = await gateToolCall("subagent", threeTasks, "/cwd");
		expect(result).toBeUndefined();
		expect(received?.kind).toBe("swarm");
		expect(received?.action).toBe("swarm");
		expect(received?.detail).toContain("agent swarm (3 subagents)");
		expect(received?.detail).toContain("one");
	});

	it("prompts in yolo mode too", async () => {
		setPermissionMode("yolo");
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "reject" as ApprovalResponse;
		});
		const result = await gateToolCall("subagent", threeTasks, "/cwd");
		expect(calls).toBe(1);
		expect(result).toEqual({ block: true, reason: "Agent swarm rejected by user." });
	});

	it("never prompts in auto mode", async () => {
		setPermissionMode("auto");
		// No handler registered — auto mode must not need one.
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toBeUndefined();
	});

	it("skips the gate for explicit /swarm turns", async () => {
		setPermissionMode("manual");
		// No handler registered — explicit swarm must not need one.
		expect(
			await gateToolCall("subagent", threeTasks, "/cwd", undefined, { explicitSwarmTurn: true }),
		).toBeUndefined();
	});

	it("fails closed without an approval handler", async () => {
		setPermissionMode("manual");
		const result = await gateToolCall("subagent", threeTasks, "/cwd");
		expect(result).toEqual({ block: true, reason: NO_SWARM_HANDLER_REASON });
	});

	it("persists session approval across swarm calls", async () => {
		setPermissionMode("manual");
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "session" as ApprovalResponse;
		});
		await gateToolCall("subagent", threeTasks, "/cwd");
		expect(await gateToolCall("subagent", { tasks: [{ agent: "x", count: 5 }] }, "/cwd")).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("reject with feedback becomes the block reason", async () => {
		setPermissionMode("manual");
		registerApprovalHandler(async () => ({ decision: "reject", feedback: "too many agents, use one" }));
		const result = await gateToolCall("subagent", threeTasks, "/cwd");
		expect(result).toEqual({
			block: true,
			reason: "Agent swarm rejected by user. too many agents, use one",
		});
	});
});
