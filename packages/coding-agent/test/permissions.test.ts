import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	effectiveLargeSubagentLaunchCount,
	effectiveLargeSubagentLaunchCountForTurn,
	LARGE_SUBAGENT_LAUNCH_THRESHOLD,
} from "../src/core/large-subagent-launch.ts";
import {
	clearSessionApprovals,
	createPermissionContext,
	deletePermissionContext,
	GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON,
	gateToolCall,
	getPermissionMode,
	isReadOnlyModeActive,
	MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON,
	NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON,
	nextPermissionMode,
	PERMISSION_MODES,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
	restorePermissionModeAfterPlan,
	SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON,
	setPermissionMode,
} from "../src/core/permissions.ts";
import { READ_ONLY_MODE_BLOCK_MESSAGE } from "../src/core/plan-mode.ts";

beforeEach(() => {
	resetAllPermissionContexts();
	registerApprovalHandler(undefined);
	clearSessionApprovals();
});

describe("permission modes", () => {
	it("defaults to yolo and cycles through exactly three modes", () => {
		expect(PERMISSION_MODES).toEqual(["yolo", "auto", "read-only"]);
		expect(getPermissionMode()).toBe("yolo");
		expect(nextPermissionMode("yolo")).toBe("auto");
		expect(nextPermissionMode("auto")).toBe("read-only");
		expect(nextPermissionMode("read-only")).toBe("yolo");
	});

	it("lets yolo and auto use mutating tools without individual approvals", async () => {
		for (const mode of ["yolo", "auto"] as const) {
			setPermissionMode(mode);
			expect(await gateToolCall("bash", { command: "mkdir out" }, "/cwd")).toBeUndefined();
			expect(await gateToolCall("write", { path: "/cwd/out" }, "/cwd")).toBeUndefined();
			expect(await gateToolCall("subagent", { task: "write", description: "Writer" }, "/cwd")).toBeUndefined();
		}
	});

	it("blocks writes and mutating bash in read-only mode without approval", async () => {
		setPermissionMode("read-only");
		let prompts = 0;
		registerApprovalHandler(async () => {
			prompts++;
			return "once";
		});
		for (const tool of ["edit", "write", "memory_add", "cron"]) {
			expect(await gateToolCall(tool, { path: "/cwd/out" }, "/cwd")).toEqual({
				block: true,
				reason: READ_ONLY_MODE_BLOCK_MESSAGE,
			});
		}
		expect((await gateToolCall("bash", { command: "mkdir out" }, "/cwd"))?.reason).toContain(
			READ_ONLY_MODE_BLOCK_MESSAGE,
		);
		expect(await gateToolCall("bash", { command: "ls -la" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("read", { path: "/cwd/out" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "x", dry_run: true }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "x", dry_run: false }, "/cwd")).toEqual({
			block: true,
			reason: READ_ONLY_MODE_BLOCK_MESSAGE,
		});
		expect(prompts).toBe(0);
		expect(isReadOnlyModeActive()).toBe(true);
	});

	it("retains protected file blocks in all modes", async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		for (const mode of PERMISSION_MODES) {
			setPermissionMode(mode);
			for (const [path, reason] of [
				[join(root, "settings.json"), SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON],
				[join(root, "agents", "AGENTS.md"), GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON],
				[join(root, "..", "simple-memory", "memory.md"), MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON],
			] as const) {
				for (const tool of ["edit", "write", "code_rewrite"]) {
					expect(await gateToolCall(tool, { path }, "/cwd"), `${mode}/${tool}`).toEqual({ block: true, reason });
				}
			}
		}
	});

	it("isolates modes between sessions", async () => {
		createPermissionContext("a", "read-only");
		createPermissionContext("b", "auto");
		expect((await gateToolCall("write", { path: "/cwd/a" }, "/cwd", "a"))?.block).toBe(true);
		expect(await gateToolCall("write", { path: "/cwd/b" }, "/cwd", "b")).toBeUndefined();
		resetPermissions("yolo", "a");
		expect(getPermissionMode("a")).toBe("yolo");
		expect(getPermissionMode("b")).toBe("auto");
		deletePermissionContext("a");
		deletePermissionContext("b");
	});

	it("restores the previous mode after planning", () => {
		expect(restorePermissionModeAfterPlan("auto", "read-only")).toBe("auto");
		expect(restorePermissionModeAfterPlan(undefined, "read-only")).toBe("yolo");
		expect(restorePermissionModeAfterPlan(undefined, "auto")).toBe("auto");
	});
});

describe("large subagent launch", () => {
	const threeTasks = {
		tasks: [
			{ task: "one", description: "One" },
			{ task: "two", description: "Two" },
			{ task: "three", description: "Three" },
		],
	};

	it("counts parallel tasks, multipliers, and sibling calls", () => {
		expect(LARGE_SUBAGENT_LAUNCH_THRESHOLD).toBe(2);
		expect(effectiveLargeSubagentLaunchCount(threeTasks)).toBe(3);
		expect(effectiveLargeSubagentLaunchCount({ tasks: [{ task: "a", description: "A", count: 4 }] })).toBe(4);
		const assistantMessage = {
			content: threeTasks.tasks.map(({ task, description }) => ({
				type: "toolCall",
				name: "subagent",
				arguments: { task, description },
			})),
		};
		expect(effectiveLargeSubagentLaunchCountForTurn({ task: "one", description: "One" }, assistantMessage)).toBe(3);
	});

	it("requires one approval in yolo and bypasses it in auto", async () => {
		let calls = 0;
		registerApprovalHandler(async (req) => {
			calls++;
			expect(req.kind).toBe("large-subagent-launch");
			return "once";
		});
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toBeUndefined();
		expect(calls).toBe(1);
		setPermissionMode("auto");
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("fails closed without a handler and respects disabled confirmation", async () => {
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toEqual({
			block: true,
			reason: NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON,
		});
		expect(
			await gateToolCall("subagent", threeTasks, "/cwd", undefined, { confirmLargeSubagentLaunches: false }),
		).toBeUndefined();
	});

	it("persists a session approval and shares same-turn decisions", async () => {
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "session";
		});
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toBeUndefined();
		expect(await gateToolCall("subagent", threeTasks, "/cwd")).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("does not prompt for read-only subagents in read-only mode", async () => {
		setPermissionMode("read-only");
		expect(await gateToolCall("subagent", { task: "inspect", permissions: "read-only" }, "/cwd")).toBeUndefined();
		expect((await gateToolCall("subagent", { task: "write" }, "/cwd"))?.block).toBe(true);
		expect((await gateToolCall("subagent", { action: "resume", id: "old-run" }, "/cwd"))?.block).toBe(true);
		expect(await gateToolCall("subagent", { action: "status", id: "old-run" }, "/cwd")).toBeUndefined();
	});
});
