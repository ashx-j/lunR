import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildProxyDescription } from "../src/builtin-extensions/pi-mcp-adapter/direct-tools.ts";
import {
	effectiveLargeSubagentLaunchCount,
	effectiveLargeSubagentLaunchCountForTurn,
	LARGE_SUBAGENT_LAUNCH_THRESHOLD,
} from "../src/core/large-subagent-launch.ts";
import { compilePermissionRules } from "../src/core/permission-rules.ts";
import {
	type ApprovalRequest,
	type ApprovalResponse,
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
import { PR_WATCH_STATE_WRITE_BLOCK_REASON } from "../src/core/protected-targets.ts";

beforeEach(() => {
	resetAllPermissionContexts();
	registerApprovalHandler(undefined);
	clearSessionApprovals();
});

describe("permission modes", () => {
	it("defaults to yolo and cycles from least to most strict", () => {
		expect(PERMISSION_MODES).toEqual(["yolo", "auto", "ask", "read-only"]);
		expect(getPermissionMode()).toBe("yolo");
		expect(nextPermissionMode("yolo")).toBe("auto");
		expect(nextPermissionMode("auto")).toBe("ask");
		expect(nextPermissionMode("ask")).toBe("read-only");
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
		expect(await gateToolCall("lsp_rename", { path: "/cwd/out", newName: "renamed" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "x", dry_run: true }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "x", dry_run: false }, "/cwd")).toEqual({
			block: true,
			reason: READ_ONLY_MODE_BLOCK_MESSAGE,
		});
		expect(prompts).toBe(0);
		expect(isReadOnlyModeActive()).toBe(true);
	});

	it("blocks MCP execution and unknown extension tools but permits MCP inspection", async () => {
		setPermissionMode("read-only");
		for (const input of [
			{ tool: "write_file", args: '{"path":"x"}' },
			{ connect: "server" },
			{ action: "auth-complete" },
		]) {
			expect((await gateToolCall("mcp", input, "/cwd"))?.block).toBe(true);
		}
		expect(await gateToolCall("mcp", { search: "tools" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("mcp", { action: "ui-messages" }, "/cwd")).toBeUndefined();
		expect((await gateToolCall("server_write_file", {}, "/cwd"))?.block).toBe(true);
		expect(buildProxyDescription({ mcpServers: {} }, null, [])).toContain("Read-only mode permits status");
	});

	it("retains protected file blocks in all modes", async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		for (const mode of PERMISSION_MODES) {
			setPermissionMode(mode);
			for (const [path, reason] of [
				[join(root, "settings.json"), SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON],
				[join(root, "pr-watches", "session.json"), PR_WATCH_STATE_WRITE_BLOCK_REASON],
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
		expect(restorePermissionModeAfterPlan(undefined, "read-only")).toBe("read-only");
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

describe("same-turn executable launch approval", () => {
	it.each([true, false, undefined])("counts singles regardless of async=%s", async (async) => {
		const calls = ["one", "two", "three"].map((task) => ({ task, description: task, async }));
		const assistantMessage = {
			content: calls.map((arguments_) => ({ type: "toolCall", name: "subagent", arguments: arguments_ })),
		};
		let prompts = 0;
		registerApprovalHandler(async () => {
			prompts++;
			return "reject";
		});
		for (const call of calls) {
			expect(effectiveLargeSubagentLaunchCountForTurn(call, assistantMessage)).toBe(3);
			expect((await gateToolCall("subagent", call, "/cwd", undefined, { assistantMessage }))?.block).toBe(true);
		}
		expect(prompts).toBe(1);
	});

	it("counts launch payloads normalized by executor dispatch and ignores control-only calls", () => {
		const launch = { action: "status", task: "inspect", description: "Inspect", async: true, tasks: [], chain: [] };
		const assistantMessage = {
			content: [
				launch,
				{ ...launch, action: "single" },
				{ task: "third", description: "Third", async: false },
				{ action: "status", id: "existing" },
			].map((arguments_) => ({ type: "toolCall", name: "subagent", arguments: arguments_ })),
		};
		expect(effectiveLargeSubagentLaunchCountForTurn(launch, assistantMessage)).toBe(3);
	});
});

describe("ask mode", () => {
	const rules = (allow: string[], deny: string[] = []) => ({
		rules: compilePermissionRules({ allow, deny }, undefined, true, "/cwd"),
	});
	const answer = (response: ApprovalResponse) => {
		const asked: ApprovalRequest[] = [];
		registerApprovalHandler(async (req) => {
			asked.push(req);
			return response;
		});
		return asked;
	};

	beforeEach(() => setPermissionMode("ask"));

	it("runs reads without asking and asks before a call read-only mode would block", async () => {
		const asked = answer("once");
		expect(await gateToolCall("read", { path: "a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("bash", { command: "git status" }, "/cwd")).toBeUndefined();
		expect(asked).toHaveLength(0);
		expect(await gateToolCall("bash", { command: "npm test" }, "/cwd")).toBeUndefined();
		expect(asked).toMatchObject([{ kind: "tool", toolName: "bash", detail: "npm test", title: "Allow bash?" }]);
		await gateToolCall("bash", { command: "npm test" }, "/cwd");
		expect(asked).toHaveLength(2);
	});

	it("remembers a session answer for the exact command only", async () => {
		const asked = answer("session");
		await gateToolCall("bash", { command: "npm test" }, "/cwd");
		await gateToolCall("bash", { command: "npm test" }, "/cwd");
		expect(asked).toHaveLength(1);
		await gateToolCall("bash", { command: "rm -rf build" }, "/cwd");
		expect(asked).toHaveLength(2);
	});

	it("returns the user's feedback to the model on reject", async () => {
		answer({ decision: "reject", feedback: "use pnpm" });
		expect(await gateToolCall("bash", { command: "npm i" }, "/cwd")).toEqual({
			block: true,
			reason: "The user rejected this call. Their feedback: use pnpm",
		});
	});

	it("blocks with a way forward when nobody can answer", async () => {
		const result = await gateToolCall("bash", { command: "npm test" }, "/cwd");
		expect(result?.reason).toContain("nobody can answer here");
		expect(result?.reason).toContain('"bash(npm test)"');
		createPermissionContext("cron", "ask", false);
		answer("once");
		expect(await gateToolCall("write", { path: "x" }, "/cwd", "cron")).toMatchObject({ block: true });
	});

	it("skips the question for an allow rule and saves one after an always answer", async () => {
		const asked = answer("always");
		expect(
			await gateToolCall("bash", { command: "npm test" }, "/cwd", undefined, rules(["bash(npm test)"])),
		).toBeUndefined();
		expect(asked).toHaveLength(0);
		const saved: string[] = [];
		await gateToolCall("bash", { command: "make" }, "/cwd", undefined, { saveAllowRule: (rule) => saved.push(rule) });
		expect(asked[0]?.rule).toBe("bash(make)");
		expect(saved).toEqual(["bash(make)"]);
	});

	it("says plainly that a full-access child runs commands without asking", async () => {
		const asked = answer("reject");
		const result = await gateToolCall("subagent", { task: "fix it", description: "Fixer" }, "/cwd");
		expect(result?.block).toBe(true);
		expect(asked[0]?.title).toBe(
			"Launch a full-access subagent? It runs commands and edits files without asking you.",
		);
		expect(
			await gateToolCall("subagent", { task: "look", description: "Reader", permissions: "read-only" }, "/cwd"),
		).toBeUndefined();
	});
});

describe("allow and deny rules in other modes", () => {
	it("blocks a denied call in yolo, and deny wins over allow", async () => {
		const options = {
			rules: compilePermissionRules(
				{ allow: ["bash(git push*)"], deny: ["bash(git push*)"] },
				undefined,
				true,
				"/cwd",
			),
		};
		expect(await gateToolCall("bash", { command: "git push" }, "/cwd", undefined, options)).toMatchObject({
			block: true,
			reason: expect.stringContaining('deny rule "bash(git push*)"'),
		});
	});

	it("never lets an allow rule pass read-only mode or a protected target", async () => {
		const options = { rules: compilePermissionRules({ allow: ["bash", "write"] }, undefined, true, "/cwd") };
		setPermissionMode("read-only");
		expect(await gateToolCall("bash", { command: "rm x" }, "/cwd", undefined, options)).toMatchObject({
			block: true,
		});
		setPermissionMode("ask");
		const settings = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
		expect(await gateToolCall("write", { path: settings }, "/cwd", undefined, options)).toEqual({
			block: true,
			reason: SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON,
		});
	});
});
