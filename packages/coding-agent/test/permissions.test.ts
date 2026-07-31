import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalResponse,
	clearSessionApprovals,
	createPermissionContext,
	deletePermissionContext,
	gateToolCall,
	getPermissionMode,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
	setPermissionMode,
} from "../src/core/permissions.ts";

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
