import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	clearSessionApprovals,
	createPermissionContext,
	deletePermissionContext,
	GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON,
	gateToolCall,
	getPermissionMode,
	isPlanModeActive,
	MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON,
	NO_SWARM_HANDLER_REASON,
	nextPermissionMode,
	registerApprovalHandler,
	resetAllPermissionContexts,
	resetPermissions,
	restorePermissionModeAfterPlan,
	setPermissionMode,
} from "../src/core/permissions.ts";
import { PLAN_MODE_BLOCK_MESSAGE } from "../src/core/plan-mode.ts";
import {
	effectiveSwarmCount,
	effectiveSwarmCountForTurn,
	isExplicitSwarmTurn,
	SWARM_APPROVAL_THRESHOLD,
} from "../src/core/swarm.ts";

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

	it("requires approval for full-access children in manual mode", async () => {
		setPermissionMode("manual");
		let received: ApprovalRequest | undefined;
		registerApprovalHandler(async (request) => {
			received = request;
			return "reject";
		});
		const result = await gateToolCall(
			"subagent",
			{ task: "write a file", description: "Implement storage", permissions: "full" },
			"/cwd",
		);
		expect(result).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
		expect(received).toMatchObject({
			toolName: "subagent",
			action: "subagent-full",
		});
		expect(received?.detail).toContain("Implement storage");
		expect(received?.detail).toContain("permissions: full");
	});

	it("treats omitted child permissions as full and lets read-only children pass", async () => {
		setPermissionMode("manual");
		expect(await gateToolCall("subagent", { task: "write", description: "Writer" }, "/cwd")).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
		expect(
			await gateToolCall("subagent", { task: "inspect", description: "Reviewer", permissions: "read-only" }, "/cwd"),
		).toBeUndefined();
	});

	it("gates full children nested in chain and parallel launch shapes", async () => {
		setPermissionMode("manual");
		const requests: ApprovalRequest[] = [];
		registerApprovalHandler(async (request) => {
			requests.push(request);
			return "once";
		});
		expect(
			await gateToolCall(
				"subagent",
				{
					chain: [
						{ task: "inspect", description: "Reviewer", permissions: "read-only" },
						{ parallel: [{ task: "fix", description: "Fixer", permissions: "full" }] },
					],
				},
				"/cwd",
			),
		).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ action: "subagent-full" });
		expect(requests[0].detail).toContain("Fixer");
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

	it("print mode without the child env stays fail-closed", async () => {
		// lunr -p / cron / gateway headless: module default is manual and no handler is registered.
		expect(getPermissionMode()).toBe("manual");
		expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
		expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
	});

	it("blocks file tools from changing user-managed global instructions in every mode", async () => {
		const agentsPath = join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md");
		for (const mode of ["manual", "yolo", "plan", "auto"] as const) {
			setPermissionMode(mode);
			for (const tool of ["edit", "write", "code_rewrite"]) {
				expect(await gateToolCall(tool, { path: agentsPath, dry_run: true }, "/cwd"), `${mode}/${tool}`).toEqual({
					block: true,
					reason: GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON,
				});
			}
		}
	});

	it("requires memory tools instead of direct file-tool writes", async () => {
		const memoryPath = join(process.env.PI_CODING_AGENT_DIR!, "..", "simple-memory", "memory.md");
		for (const mode of ["manual", "yolo", "plan", "auto"] as const) {
			setPermissionMode(mode);
			for (const tool of ["edit", "write", "code_rewrite"]) {
				expect(await gateToolCall(tool, { path: memoryPath, dry_run: true }, "/cwd"), `${mode}/${tool}`).toEqual({
					block: true,
					reason: MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON,
				});
			}
		}
	});

	it("memory_add and cron are gated as mutating tools in manual mode", async () => {
		setPermissionMode("manual");
		registerApprovalHandler(async () => "reject" as ApprovalResponse);
		const memory = await gateToolCall("memory_add", { content: "user likes dark mode" }, "/cwd");
		expect(memory).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
		const cron = await gateToolCall("cron", { action: "create" }, "/cwd");
		expect(cron).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
	});

	it("prompts for apply-mode code_rewrite and allows dry-run in manual mode", async () => {
		setPermissionMode("manual");
		let received: ApprovalRequest | undefined;
		registerApprovalHandler(async (req) => {
			received = req;
			return "once" as ApprovalResponse;
		});
		expect(await gateToolCall("code_rewrite", { dry_run: true, pattern: "Foo" }, "/cwd")).toBeUndefined();
		expect(received).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "Foo" }, "/cwd")).toBeUndefined();
		expect(received).toBeUndefined();
		const apply = await gateToolCall("code_rewrite", { dry_run: false, path: "src/a.ts", pattern: "Foo" }, "/cwd");
		expect(apply).toBeUndefined();
		expect(received?.toolName).toBe("code_rewrite");
		expect(received?.action).toBe("code_rewrite");
		expect(received?.detail).toBe("src/a.ts");

		registerApprovalHandler(undefined);
		const failClosed = await gateToolCall("code_rewrite", { dry_run: false, pattern: "Foo" }, "/cwd");
		expect(failClosed).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
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
		expect(
			effectiveSwarmCount({
				tasks: [
					{ task: "a", description: "A" },
					{ task: "b", description: "B" },
				],
			}),
		).toBe(2);
		expect(effectiveSwarmCount({ tasks: [{ task: "a", description: "A", count: 3 }] })).toBe(3);
		expect(
			effectiveSwarmCount({
				tasks: [
					{ task: "a", description: "A", count: 0 },
					{ task: "b", description: "B" },
				],
			}),
		).toBe(2);
	});

	it("counts chain parallel fan-out blocks", () => {
		expect(
			effectiveSwarmCount({
				chain: [
					{ task: "a", description: "A" },
					{
						parallel: [
							{ task: "b", description: "B" },
							{ task: "c", description: "C", count: 2 },
						],
					},
				],
			}),
		).toBe(3);
	});

	it("counts zero for single-agent and management calls", () => {
		expect(effectiveSwarmCount({ task: "x", description: "Scout files" })).toBe(0);
		expect(effectiveSwarmCount({ action: "status" })).toBe(0);
		expect(
			effectiveSwarmCount({
				chain: [
					{ task: "a", description: "A" },
					{ task: "b", description: "B" },
				],
			}),
		).toBe(0);
	});

	it("counts same-turn sibling SINGLE calls toward the swarm threshold", () => {
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "three", description: "Three" } },
			],
		};
		expect(effectiveSwarmCountForTurn({ task: "one", description: "One" }, assistantMessage)).toBe(3);
		expect(
			effectiveSwarmCountForTurn(
				{
					tasks: [
						{ task: "a", description: "A" },
						{ task: "b", description: "B" },
					],
				},
				assistantMessage,
			),
		).toBe(3);
	});

	it("ignores async and management siblings when counting same-turn singles", () => {
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two", async: true } },
				{ type: "toolCall", name: "subagent", arguments: { action: "status" } },
			],
		};
		expect(effectiveSwarmCountForTurn({ task: "one", description: "One" }, assistantMessage)).toBe(1);
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
			{ task: "one", description: "One" },
			{ task: "two", description: "Two" },
			{ task: "three", description: "Three" },
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

	it("allows read-only subagent calls at or below the threshold without a handler", async () => {
		setPermissionMode("manual");
		expect(
			await gateToolCall("subagent", { task: "x", description: "Scout files", permissions: "read-only" }, "/cwd"),
		).toBeUndefined();
		expect(
			await gateToolCall(
				"subagent",
				{
					tasks: [
						{ task: "a", description: "A", permissions: "read-only" },
						{ task: "b", description: "B", permissions: "read-only" },
					],
				},
				"/cwd",
			),
		).toBeUndefined();
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
		expect(received?.detail).toContain("One");
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

	it("skips the swarm gate for explicit /swarm turns but still protects full children", async () => {
		setPermissionMode("manual");
		expect(await gateToolCall("subagent", threeTasks, "/cwd", undefined, { explicitSwarmTurn: true })).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
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
		expect(
			await gateToolCall("subagent", { tasks: [{ task: "x", description: "X", count: 5 }] }, "/cwd"),
		).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("does not let a read-only swarm approval cover a later full child", async () => {
		setPermissionMode("manual");
		const actions: string[] = [];
		registerApprovalHandler(async (request) => {
			actions.push(request.action);
			return actions.length === 1 ? "session" : "reject";
		});
		const readOnlySwarm = {
			tasks: threeTasks.tasks.map((task) => ({ ...task, permissions: "read-only" as const })),
		};
		expect(await gateToolCall("subagent", readOnlySwarm, "/cwd")).toBeUndefined();
		expect(
			await gateToolCall("subagent", { task: "write", description: "Writer", permissions: "full" }, "/cwd"),
		).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
		expect(actions).toEqual(["swarm", "subagent-full"]);
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

	it("prompts once for three same-turn SINGLE subagent calls", async () => {
		setPermissionMode("manual");
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "three", description: "Three" } },
			],
		};
		let calls = 0;
		registerApprovalHandler(async (req) => {
			calls++;
			expect(req.kind).toBe("swarm");
			expect(req.detail).toContain("agent swarm (3 subagents)");
			return "once" as ApprovalResponse;
		});
		const options = { assistantMessage };
		expect(
			await gateToolCall("subagent", { task: "one", description: "One" }, "/cwd", undefined, options),
		).toBeUndefined();
		expect(
			await gateToolCall("subagent", { task: "two", description: "Two" }, "/cwd", undefined, options),
		).toBeUndefined();
		expect(
			await gateToolCall("subagent", { task: "three", description: "Three" }, "/cwd", undefined, options),
		).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("one reject covers every sibling SINGLE on the same assistant message", async () => {
		setPermissionMode("yolo");
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "three", description: "Three" } },
			],
		};
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return { decision: "reject", feedback: "use tasks" };
		});
		const options = { assistantMessage };
		const first = await gateToolCall("subagent", { task: "one", description: "One" }, "/cwd", undefined, options);
		const second = await gateToolCall("subagent", { task: "two", description: "Two" }, "/cwd", undefined, options);
		expect(first).toEqual({ block: true, reason: "Agent swarm rejected by user. use tasks" });
		expect(second).toEqual({ block: true, reason: "Agent swarm rejected by user. use tasks" });
		expect(calls).toBe(1);
	});
});

describe("plan permission mode", () => {
	beforeEach(() => {
		resetAllPermissionContexts();
		resetPermissions("manual");
		registerApprovalHandler(undefined);
		clearSessionApprovals();
	});

	it("isPlanModeActive follows getPermissionMode", () => {
		expect(isPlanModeActive()).toBe(false);
		setPermissionMode("plan");
		expect(isPlanModeActive()).toBe(true);
		setPermissionMode("yolo");
		expect(isPlanModeActive()).toBe(false);
	});

	it("hard-blocks edit/write without prompting", async () => {
		setPermissionMode("plan");
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "once";
		});
		expect(await gateToolCall("edit", { path: "/cwd/a.ts" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
		expect(await gateToolCall("write", { path: "/cwd/b.ts" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
		expect(calls).toBe(0);
	});

	it("hard-blocks mutating bash and allows read-only bash", async () => {
		setPermissionMode("plan");
		const blocked = await gateToolCall("bash", { command: "rm -rf dist" }, "/cwd");
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain(PLAN_MODE_BLOCK_MESSAGE);
		expect(blocked?.reason).toContain("rm -rf dist");
		expect(await gateToolCall("bash", { command: "ls -la" }, "/cwd")).toBeUndefined();
	});

	it("allows read tools", async () => {
		setPermissionMode("plan");
		expect(await gateToolCall("read", { path: "/cwd/a.ts" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("ls", {}, "/cwd")).toBeUndefined();
	});

	it("hard-blocks apply-mode code_rewrite and allows dry-run", async () => {
		setPermissionMode("plan");
		let calls = 0;
		registerApprovalHandler(async () => {
			calls++;
			return "once";
		});
		expect(await gateToolCall("code_rewrite", { dry_run: false, pattern: "x" }, "/cwd")).toEqual({
			block: true,
			reason: PLAN_MODE_BLOCK_MESSAGE,
		});
		expect(await gateToolCall("code_rewrite", { dry_run: true, pattern: "x" }, "/cwd")).toBeUndefined();
		expect(await gateToolCall("code_rewrite", { pattern: "x" }, "/cwd")).toBeUndefined();
		expect(calls).toBe(0);
	});
});

describe("nextPermissionMode", () => {
	it("walks manual → yolo → plan → auto → manual", () => {
		expect(nextPermissionMode("manual")).toBe("yolo");
		expect(nextPermissionMode("yolo")).toBe("plan");
		expect(nextPermissionMode("plan")).toBe("auto");
		expect(nextPermissionMode("auto")).toBe("manual");
	});
});

describe("restorePermissionModeAfterPlan", () => {
	it("restores the previous non-plan mode", () => {
		expect(restorePermissionModeAfterPlan("yolo", "manual")).toBe("yolo");
		expect(restorePermissionModeAfterPlan("auto", "manual")).toBe("auto");
	});

	it("falls back to the configured default when there is no previous", () => {
		expect(restorePermissionModeAfterPlan(undefined, "manual")).toBe("manual");
		expect(restorePermissionModeAfterPlan(undefined, "yolo")).toBe("yolo");
	});

	it("falls back to yolo when previous is missing and the default is plan", () => {
		expect(restorePermissionModeAfterPlan(undefined, "plan")).toBe("yolo");
		expect(restorePermissionModeAfterPlan("plan", "plan")).toBe("yolo");
	});
});
