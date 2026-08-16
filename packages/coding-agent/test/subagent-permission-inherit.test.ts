import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiArgs } from "../src/builtin-extensions/pi-subagents/src/runs/shared/pi-args.ts";
import {
	gateToolCall,
	getPermissionMode,
	NO_HANDLER_REASON,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
	setPermissionMode,
} from "../src/core/permissions.ts";
import { PLAN_MODE_BLOCK_MESSAGE } from "../src/core/plan-mode.ts";
import {
	applyInheritedSubagentPermissions,
	filterToolsForInheritedChild,
	isWriteCapableSubagent,
	PLAN_MODE_WRITE_SPAWN_ERROR,
	planModeWriteSpawnError,
	resolveChildPermissionMode,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_PARENT_PERMISSION_MODE_ENV,
	snapshotParentPermissionMode,
} from "../src/core/subagent-permission-inherit.ts";

const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const SCOUT_TOOLS = ["read", "grep", "find", "ls", "bash", "write"];

describe("subagent permission inherit", () => {
	beforeEach(() => {
		resetAllPermissionContexts();
		resetPermissions("manual");
		registerApprovalHandler(undefined);
	});

	afterEach(() => {
		resetAllPermissionContexts();
		resetPermissions("manual");
		registerApprovalHandler(undefined);
	});

	it("maps parent auto/manual/yolo to child auto, and parent plan to child plan", () => {
		expect(resolveChildPermissionMode("auto")).toBe("auto");
		expect(resolveChildPermissionMode("manual")).toBe("auto");
		expect(resolveChildPermissionMode("yolo")).toBe("auto");
		expect(resolveChildPermissionMode("plan")).toBe("plan");
	});

	it("treats missing or unknown parent mode as auto on a real child", () => {
		expect(resolveChildPermissionMode(undefined)).toBe("auto");
		expect(resolveChildPermissionMode("")).toBe("auto");
		expect(resolveChildPermissionMode("weird")).toBe("auto");
	});

	it("does not apply inherit to non-child print processes", () => {
		expect(applyInheritedSubagentPermissions({})).toBeUndefined();
		expect(getPermissionMode()).toBe("manual");
	});

	it("ignores leftover parent-mode env when this process is not a child", () => {
		expect(
			applyInheritedSubagentPermissions({
				[SUBAGENT_PARENT_PERMISSION_MODE_ENV]: "auto",
			}),
		).toBeUndefined();
		expect(getPermissionMode()).toBe("manual");
	});

	it("applies auto to a child when the parent-mode env is missing", () => {
		expect(applyInheritedSubagentPermissions({ [SUBAGENT_CHILD_ENV]: "1" })).toBe("auto");
		expect(getPermissionMode()).toBe("auto");
	});

	it("applies plan to a child when the parent was in plan", () => {
		expect(
			applyInheritedSubagentPermissions({
				[SUBAGENT_CHILD_ENV]: "1",
				[SUBAGENT_PARENT_PERMISSION_MODE_ENV]: "plan",
			}),
		).toBe("plan");
		expect(getPermissionMode()).toBe("plan");
	});

	it("lets a child of auto/manual/yolo write without an approval handler", async () => {
		for (const parent of ["auto", "manual", "yolo"] as const) {
			resetPermissions("manual");
			registerApprovalHandler(undefined);
			applyInheritedSubagentPermissions({
				[SUBAGENT_CHILD_ENV]: "1",
				[SUBAGENT_PARENT_PERMISSION_MODE_ENV]: parent,
			});
			expect(await gateToolCall("read", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
			expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
			expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toBeUndefined();
			expect(await gateToolCall("bash", { command: "echo hi" }, "/cwd")).toBeUndefined();
			const blocked = await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd");
			expect(blocked?.reason).not.toBe(NO_HANDLER_REASON);
		}
	});

	it("lets a child of a missing parent mode write without an approval handler", async () => {
		applyInheritedSubagentPermissions({ [SUBAGENT_CHILD_ENV]: "1" });
		expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toBeUndefined();
	});

	it("blocks write tools for a child of a plan parent", async () => {
		applyInheritedSubagentPermissions({
			[SUBAGENT_CHILD_ENV]: "1",
			[SUBAGENT_PARENT_PERMISSION_MODE_ENV]: "plan",
		});
		expect(await gateToolCall("read", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("ls", {}, "/cwd")).toBeUndefined();
		expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
		expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
		expect(await gateToolCall("code_rewrite", { dry_run: true, pattern: "Foo" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { dry_run: false, pattern: "Foo" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
	});

	it("snapshots the live parent mode at spawn", () => {
		setPermissionMode("yolo");
		expect(snapshotParentPermissionMode()).toBe("yolo");
		setPermissionMode("plan");
		expect(snapshotParentPermissionMode()).toBe("plan");
	});

	it("classifies worker/delegate/custom editors as write-capable", () => {
		expect(isWriteCapableSubagent("worker", WORKER_TOOLS)).toBe(true);
		expect(isWriteCapableSubagent("delegate", WORKER_TOOLS)).toBe(true);
		expect(isWriteCapableSubagent("pkg.custom-editor", ["read", "edit"])).toBe(true);
		expect(isWriteCapableSubagent("custom", ["read", "write"])).toBe(true);
		expect(isWriteCapableSubagent("custom", undefined)).toBe(true);
	});

	it("does not treat scout/reviewer/researcher as write-capable", () => {
		expect(isWriteCapableSubagent("scout", SCOUT_TOOLS)).toBe(false);
		expect(isWriteCapableSubagent("reviewer", ["read", "grep", "bash", "edit", "write"])).toBe(false);
		expect(isWriteCapableSubagent("researcher", ["read", "write", "web_search"])).toBe(false);
		expect(isWriteCapableSubagent("status", ["read", "ls"])).toBe(false);
	});

	it("fails plan-parent writer launches and allows read-only agents", () => {
		expect(planModeWriteSpawnError("plan", [{ name: "worker", tools: WORKER_TOOLS }])).toBe(
			PLAN_MODE_WRITE_SPAWN_ERROR,
		);
		expect(planModeWriteSpawnError("plan", [{ name: "custom", tools: ["edit"] }])).toBe(PLAN_MODE_WRITE_SPAWN_ERROR);
		expect(planModeWriteSpawnError("plan", [{ name: "scout", tools: SCOUT_TOOLS }])).toBeUndefined();
		expect(planModeWriteSpawnError("plan", [{ name: "reviewer" }])).toBeUndefined();
		expect(planModeWriteSpawnError("yolo", [{ name: "worker", tools: WORKER_TOOLS }])).toBeUndefined();
		expect(planModeWriteSpawnError("manual", [{ name: "worker", tools: WORKER_TOOLS }])).toBeUndefined();
	});

	it("strips mutating tools from a plan child's allowlist and leaves writer tools otherwise", () => {
		expect(filterToolsForInheritedChild(WORKER_TOOLS, "plan")).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(filterToolsForInheritedChild(WORKER_TOOLS, "yolo")).toEqual(WORKER_TOOLS);
		expect(filterToolsForInheritedChild(WORKER_TOOLS, "manual")).toEqual(WORKER_TOOLS);
		expect(filterToolsForInheritedChild(["read", "code_rewrite", "write"], "plan")).toEqual(["read"]);
	});

	it("writes the parent permission mode into the child env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "do the work",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: false,
			parentPermissionMode: "yolo",
		});
		expect(env[SUBAGENT_CHILD_ENV]).toBe("1");
		expect(env[SUBAGENT_PARENT_PERMISSION_MODE_ENV]).toBe("yolo");
	});
});
