import { describe, it, expect, beforeEach } from "vitest";
import {
	gateToolCall,
	getPermissionMode,
	setPermissionMode,
	resetPermissions,
	registerApprovalHandler,
	clearSessionApprovals,
	type ApprovalResponse,
} from "../src/core/permissions.ts";

describe("permissions", () => {
	beforeEach(() => {
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

	it("allows when no handler registered (non-TUI safety)", async () => {
		setPermissionMode("manual");
		const result = await gateToolCall("bash", { command: "ls" }, "/cwd");
		expect(result).toBeUndefined();
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
});