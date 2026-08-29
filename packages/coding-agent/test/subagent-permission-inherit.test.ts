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
	PLAN_MODE_WRITE_SPAWN_ERROR,
	resolveChildPermissions,
	resolveChildRuntimePermissionMode,
	resolveRequestedChildPermission,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_CHILD_PERMISSION_ENV,
	SUBAGENT_PARENT_PERMISSION_MODE_ENV,
	snapshotParentPermissionMode,
} from "../src/core/subagent-permission-inherit.ts";

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

	it("resolves omitted permissions to full", () => {
		expect(resolveRequestedChildPermission(undefined)).toBe("full");
		expect(resolveRequestedChildPermission("full")).toBe("full");
		expect(resolveRequestedChildPermission("read-only")).toBe("read-only");
	});

	it("maps full to child auto and read-only to child plan", () => {
		expect(resolveChildRuntimePermissionMode("full")).toBe("auto");
		expect(resolveChildRuntimePermissionMode("read-only")).toBe("plan");
		expect(resolveChildRuntimePermissionMode(undefined)).toBe("auto");
	});

	it("lets manual/yolo/auto parents launch full and read-only children", () => {
		for (const parent of ["manual", "yolo", "auto"] as const) {
			expect(resolveChildPermissions(parent, undefined)).toEqual({
				ok: true,
				requested: "full",
				effective: "full",
			});
			expect(resolveChildPermissions(parent, "full")).toEqual({
				ok: true,
				requested: "full",
				effective: "full",
			});
			expect(resolveChildPermissions(parent, "read-only")).toEqual({
				ok: true,
				requested: "read-only",
				effective: "read-only",
			});
		}
	});

	it("lets plan parents launch only explicit read-only children", () => {
		expect(resolveChildPermissions("plan", "read-only")).toEqual({
			ok: true,
			requested: "read-only",
			effective: "read-only",
		});
		expect(resolveChildPermissions("plan", "full")).toEqual({
			ok: false,
			requested: "full",
			error: PLAN_MODE_WRITE_SPAWN_ERROR,
		});
		expect(resolveChildPermissions("plan", undefined)).toEqual({
			ok: false,
			requested: "full",
			error: PLAN_MODE_WRITE_SPAWN_ERROR,
		});
		expect(PLAN_MODE_WRITE_SPAWN_ERROR).toContain('permissions: "read-only"');
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

	it("applies auto to a full child when the permission env is missing", () => {
		expect(applyInheritedSubagentPermissions({ [SUBAGENT_CHILD_ENV]: "1" })).toBe("auto");
		expect(getPermissionMode()).toBe("auto");
	});

	it("applies plan to a read-only child", () => {
		expect(
			applyInheritedSubagentPermissions({
				[SUBAGENT_CHILD_ENV]: "1",
				[SUBAGENT_CHILD_PERMISSION_ENV]: "read-only",
			}),
		).toBe("plan");
		expect(getPermissionMode()).toBe("plan");
	});

	it("lets a full child write without an approval handler", async () => {
		applyInheritedSubagentPermissions({
			[SUBAGENT_CHILD_ENV]: "1",
			[SUBAGENT_CHILD_PERMISSION_ENV]: "full",
		});
		expect(await gateToolCall("read", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("bash", { command: "echo hi" }, "/cwd")).toBeUndefined();
		const blocked = await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd");
		expect(blocked?.reason).not.toBe(NO_HANDLER_REASON);
	});

	it("blocks write tools for a read-only child", async () => {
		applyInheritedSubagentPermissions({
			[SUBAGENT_CHILD_ENV]: "1",
			[SUBAGENT_CHILD_PERMISSION_ENV]: "read-only",
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

	it("writes the resolved child permission into the child env", () => {
		const { env, args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "do the work",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: false,
			childPermission: "full",
			excludeTools: ["cron", "memory_add"],
		});
		expect(env[SUBAGENT_CHILD_ENV]).toBe("1");
		expect(env[SUBAGENT_CHILD_PERMISSION_ENV]).toBe("full");
		expect(env[SUBAGENT_PARENT_PERMISSION_MODE_ENV]).toBe("");
		expect(args).toContain("--exclude-tools");
		expect(args.some((arg) => String(arg).includes("cron"))).toBe(true);
	});
});
