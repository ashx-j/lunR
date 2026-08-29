import { describe, expect, it } from "vitest";
import {
	ChainItem,
	DynamicParallelTemplateSchema,
	ParallelTaskSchema,
	SubagentParams,
} from "../src/builtin-extensions/pi-subagents/src/extension/schemas.ts";
import {
	COMPACT_SUBAGENT_TOOL_DESCRIPTION,
	FULL_SUBAGENT_TOOL_DESCRIPTION,
} from "../src/builtin-extensions/pi-subagents/src/extension/tool-description.ts";
import {
	PARENT_OWNED_CHILD_TOOLS,
	READ_ONLY_EXCLUDED_CHILD_TOOLS,
	resolveChildExcludeTools,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-tools.ts";
import {
	CHILD_DESCRIPTION_MAX_LENGTH,
	normalizeChildSpec,
	validateChildDescription,
} from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import { REMOVED_SUBAGENT_ACTIONS, SUBAGENT_ACTIONS } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { PLAN_MODE_WRITE_SPAWN_ERROR } from "../src/core/subagent-permission-inherit.ts";
import { effectiveSwarmCountForTurn } from "../src/core/swarm.ts";

function schemaProperties(schema: { properties?: Record<string, unknown> }): string[] {
	return Object.keys(schema.properties ?? {});
}

describe("prompt-driven subagent schema", () => {
	it("does not require or expose agent on execution shapes", () => {
		for (const schema of [SubagentParams, ParallelTaskSchema, DynamicParallelTemplateSchema, ChainItem]) {
			expect(schemaProperties(schema)).not.toContain("agent");
			expect(schemaProperties(schema)).not.toContain("agentScope");
		}
	});

	it("requires description on parallel and dynamic tasks", () => {
		expect(schemaProperties(ParallelTaskSchema)).toContain("description");
		expect(schemaProperties(DynamicParallelTemplateSchema)).toContain("description");
		expect((ParallelTaskSchema as { required?: string[] }).required).toContain("description");
		expect((DynamicParallelTemplateSchema as { required?: string[] }).required).toContain("description");
	});

	it("removes agent-definition management actions", () => {
		for (const action of REMOVED_SUBAGENT_ACTIONS) {
			expect(SUBAGENT_ACTIONS).not.toContain(action);
		}
		expect(SUBAGENT_ACTIONS).toEqual(
			expect.arrayContaining(["status", "interrupt", "stop", "resume", "steer", "doctor"]),
		);
	});

	it("tool descriptions prompt children directly instead of roster discovery", () => {
		for (const text of [FULL_SUBAGENT_TOOL_DESCRIPTION, COMPACT_SUBAGENT_TOOL_DESCRIPTION]) {
			expect(text.toLowerCase()).not.toContain('{ action: "list" }');
			expect(text.toLowerCase()).not.toContain('use { action: "list" }');
			expect(text).toContain("description");
			expect(text).toContain("permissions");
			expect(text).toContain("read-only");
		}
	});
});

describe("child description validation", () => {
	it("requires a concise single-line label", () => {
		expect(validateChildDescription("Search auth flow for bugs")).toBe("Search auth flow for bugs");
		expect(() => validateChildDescription("")).toThrow(/required/);
		expect(() => validateChildDescription("line1\nline2")).toThrow(/single line/);
		expect(() => validateChildDescription("x".repeat(CHILD_DESCRIPTION_MAX_LENGTH + 1))).toThrow(/at most/);
	});

	it("persists description and omitted permissions as full", () => {
		const spec = normalizeChildSpec(
			{ task: "Inspect auth.", description: "Search auth flow for bugs" },
			{ parentMode: "auto", runId: "abcd1234", index: 0 },
		);
		expect(spec.description).toBe("Search auth flow for bugs");
		expect(spec.requestedPermissions).toBe("full");
		expect(spec.effectivePermissions).toBe("full");
		expect(spec.childId).toBe("abcd1234-0");
	});

	it("rejects full and omitted permissions from plan parents", () => {
		expect(() =>
			normalizeChildSpec(
				{ task: "Edit files", description: "Merge PR #26" },
				{ parentMode: "plan", runId: "run", index: 0 },
			),
		).toThrow(PLAN_MODE_WRITE_SPAWN_ERROR);
		expect(() =>
			normalizeChildSpec(
				{ task: "Edit files", description: "Merge PR #26", permissions: "full" },
				{ parentMode: "plan", runId: "run", index: 1 },
			),
		).toThrow(PLAN_MODE_WRITE_SPAWN_ERROR);
	});

	it("allows explicit read-only children from plan parents", () => {
		const spec = normalizeChildSpec(
			{ task: "Inspect auth.", description: "Search auth flow for bugs", permissions: "read-only" },
			{ parentMode: "plan", runId: "run", index: 2 },
		);
		expect(spec.effectivePermissions).toBe("read-only");
	});
});

describe("child-safe tool sets", () => {
	it("excludes parent-owned tools even in full mode", () => {
		const excluded = resolveChildExcludeTools({ permissions: "full" });
		for (const tool of PARENT_OWNED_CHILD_TOOLS) {
			if (tool === "subagent") expect(excluded).toContain("subagent");
			else expect(excluded).toContain(tool);
		}
		expect(excluded).toContain("cron");
		expect(excluded).toContain("memory_add");
		expect(excluded).toContain("behavior_add");
		expect(excluded).toContain("present_plan");
		expect(excluded).toContain("goal_complete");
		expect(excluded).not.toContain("edit");
		expect(excluded).not.toContain("write");
		expect(excluded).not.toContain("bash");
		expect(excluded).not.toContain("web_search");
	});

	it("keeps subagent only for fanout children", () => {
		expect(resolveChildExcludeTools({ permissions: "full" })).toContain("subagent");
		expect(resolveChildExcludeTools({ permissions: "full", fanoutAuthorized: true })).not.toContain("subagent");
	});

	it("omits edit/write/code_rewrite from read-only children", () => {
		const excluded = resolveChildExcludeTools({ permissions: "read-only" });
		for (const tool of READ_ONLY_EXCLUDED_CHILD_TOOLS) expect(excluded).toContain(tool);
		expect(excluded).toContain("cron");
	});
});

describe("same-turn swarm gate still counts generic singles", () => {
	it("counts three same-turn SINGLE calls without agent names", () => {
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "three", description: "Three" } },
			],
		};
		expect(effectiveSwarmCountForTurn({ task: "one", description: "One" }, assistantMessage)).toBe(3);
	});
});
