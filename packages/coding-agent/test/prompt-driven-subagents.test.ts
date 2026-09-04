import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { buildAsyncRunnerSteps } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
	readAsyncRecoveryDescriptor,
	resolveAsyncResumeTarget,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/async-resume.ts";
import { sanitizeScheduledParams } from "../src/builtin-extensions/pi-subagents/src/runs/background/scheduled-runs.ts";
import {
	PARENT_OWNED_CHILD_TOOLS,
	READ_ONLY_EXCLUDED_CHILD_TOOLS,
	resolveChildExcludeTools,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-tools.ts";
import {
	DynamicFanoutError,
	materializeDynamicParallelStep,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/dynamic-fanout.ts";
import {
	CHILD_DESCRIPTION_MAX_LENGTH,
	normalizeChildSpec,
	validateChildDescription,
} from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import { REMOVED_SUBAGENT_ACTIONS, SUBAGENT_ACTIONS } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { buildChainExpressionSteps } from "../src/builtin-extensions/pi-subagents/src/slash/slash-commands.ts";
import { effectiveLargeSubagentLaunchCountForTurn } from "../src/core/large-subagent-launch.ts";
import { MODEL_TIERS_BRIDGE_SYMBOL } from "../src/core/model-tiers.ts";
import { PLAN_MODE_WRITE_SPAWN_ERROR } from "../src/core/subagent-permission-inherit.ts";

const AVAILABLE_MODELS = [{ provider: "xai", id: "grok-4", fullId: "xai/grok-4" }];

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

	it("requires tier on executable task schemas and exposes no direct model override", () => {
		for (const schema of [SubagentParams, ParallelTaskSchema, DynamicParallelTemplateSchema, ChainItem]) {
			expect(schemaProperties(schema)).not.toContain("model");
		}
		expect((ParallelTaskSchema as { required?: string[] }).required).toContain("tier");
		expect((DynamicParallelTemplateSchema as { required?: string[] }).required).toContain("tier");
		expect(schemaProperties(SubagentParams)).toContain("tier");
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
			{ task: "Inspect auth.", description: "Search auth flow for bugs", tier: "light" },
			{ parentMode: "auto", runId: "abcd1234", index: 0 },
		);
		expect(spec.description).toBe("Search auth flow for bugs");
		expect(spec.requestedPermissions).toBe("full");
		expect(spec.effectivePermissions).toBe("full");
		expect(spec.childId).toBe("abcd1234-0");
		expect(spec.modelSelection).toEqual({ kind: "tier", tier: "light" });
	});

	it("rejects missing tiers and retired direct model overrides", () => {
		expect(() =>
			normalizeChildSpec(
				{ task: "Inspect auth.", description: "Search auth flow" },
				{ parentMode: "auto", runId: "run", index: 0 },
			),
		).toThrow(/tier is required/i);
		expect(() =>
			normalizeChildSpec(
				{ task: "Inspect auth.", description: "Search auth flow", tier: "light", model: "xai/grok-4" },
				{ parentMode: "auto", runId: "run", index: 0 },
			),
		).toThrow(/model is not supported/i);
	});

	it("rejects full and omitted permissions from plan parents", () => {
		expect(() =>
			normalizeChildSpec(
				{ task: "Edit files", description: "Merge PR #26", tier: "standard" },
				{ parentMode: "plan", runId: "run", index: 0 },
			),
		).toThrow(PLAN_MODE_WRITE_SPAWN_ERROR);
		expect(() =>
			normalizeChildSpec(
				{ task: "Edit files", description: "Merge PR #26", permissions: "full", tier: "standard" },
				{ parentMode: "plan", runId: "run", index: 1 },
			),
		).toThrow(PLAN_MODE_WRITE_SPAWN_ERROR);
	});

	it("allows explicit read-only children from plan parents", () => {
		const spec = normalizeChildSpec(
			{ task: "Inspect auth.", description: "Search auth flow for bugs", permissions: "read-only", tier: "light" },
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
		expect(excluded).not.toContain("behavior_add");
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

describe("same-turn large-launch gate counts generic singles", () => {
	it("counts three same-turn SINGLE calls without agent names", () => {
		const assistantMessage = {
			content: [
				{ type: "toolCall", name: "subagent", arguments: { task: "one", description: "One" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "two", description: "Two" } },
				{ type: "toolCall", name: "subagent", arguments: { task: "three", description: "Three" } },
			],
		};
		expect(effectiveLargeSubagentLaunchCountForTurn({ task: "one", description: "One" }, assistantMessage)).toBe(3);
	});
});

describe("prompt-driven execution paths", () => {
	beforeEach(() => {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => true,
			getTierModel: () => "xai/grok-4",
		};
	});

	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL];
	});

	it("builds async runner steps from ChildSpec fields without named-agent lookup", () => {
		const built = buildAsyncRunnerSteps("async-run", {
			chain: [
				{
					task: "Inspect the permission boundary.",
					description: "Audit permission boundary",
					permissions: "read-only",
					tier: "light",
					output: false,
				},
			],
			ctx: {
				pi: { events: { emit() {} } } as never,
				cwd: process.cwd(),
				currentSessionId: "test-session",
			},
			maxSubagentDepth: 1,
			availableModels: AVAILABLE_MODELS,
			asyncDir: path.join(os.tmpdir(), "lunr-prompt-driven-async-test"),
		});
		expect(built).not.toHaveProperty("error");
		if ("error" in built) return;
		const step = built.steps[0] as Record<string, unknown>;
		expect(step).toMatchObject({
			childId: "async-run-0",
			description: "Audit permission boundary",
			permissions: "read-only",
			tier: "light",
			agent: "Audit permission boundary",
			inheritProjectContext: true,
			inheritSkills: false,
		});
	});

	it("accepts generic scheduled single runs and strips schedule controls", () => {
		const result = sanitizeScheduledParams({
			action: "schedule",
			schedule: "+10m",
			task: "Inspect the release notes.",
			description: "Review release notes",
			permissions: "read-only",
			tier: "light",
		});
		expect(result.error).toBeUndefined();
		expect(result.params).toMatchObject({
			task: "Inspect the release notes.",
			description: "Review release notes",
			permissions: "read-only",
			tier: "light",
			async: true,
			context: "fresh",
		});
		expect(result.params).not.toHaveProperty("action");
		expect(result.params).not.toHaveProperty("schedule");
	});

	it("uses an isolated ChildSpec namespace for async appended steps", () => {
		const built = buildAsyncRunnerSteps("root-run", {
			chain: [
				{
					task: "Continue from {previous}",
					description: "Verify appended fix",
					permissions: "read-only",
					tier: "standard",
				},
			],
			ctx: {
				pi: { events: { emit() {} } } as never,
				cwd: process.cwd(),
				currentSessionId: "test-session",
			},
			maxSubagentDepth: 1,
			availableModels: AVAILABLE_MODELS,
			asyncDir: path.join(os.tmpdir(), "lunr-prompt-driven-append-test"),
			childIdRunId: "root-run-append-abc123",
		});
		expect(built).not.toHaveProperty("error");
		if ("error" in built) return;
		expect((built.steps[0] as { childId?: string }).childId).toBe("root-run-append-abc123-0");
	});

	it("gives separate private id bases to multiple async dynamic groups", () => {
		const dynamic = (name: string) => ({
			expand: { from: { output: "targets", path: "/items" }, item: "item", maxItems: 1 },
			parallel: {
				task: `Review ${name} {item.path}`,
				description: `Review ${name} {item.path}`,
				permissions: "read-only",
				tier: "light",
			},
			collect: { as: `${name}Reviews` },
		});
		const built = buildAsyncRunnerSteps("dynamic-run", {
			chain: [dynamic("first"), dynamic("second")] as never,
			ctx: {
				pi: { events: { emit() {} } } as never,
				cwd: process.cwd(),
				currentSessionId: "test-session",
			},
			maxSubagentDepth: 1,
			availableModels: AVAILABLE_MODELS,
			dynamicFanoutMaxItems: 1,
			asyncDir: path.join(os.tmpdir(), "lunr-prompt-driven-dynamic-test"),
			validateOutputBindings: false,
		});
		expect(built).not.toHaveProperty("error");
		if ("error" in built) return;
		const ids = built.steps.map((step) => (step as { parallel?: { childId?: string } }).parallel?.childId);
		expect(ids).toEqual(["dynamic-run-0", "dynamic-run-1"]);
	});

	it("routes live async controls by private child id, not display description", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-child-route-"));
		const asyncRoot = path.join(root, "async");
		const resultsRoot = path.join(root, "results");
		const runDir = path.join(asyncRoot, "route-run");
		fs.mkdirSync(runDir, { recursive: true });
		fs.mkdirSync(resultsRoot, { recursive: true });
		try {
			fs.writeFileSync(
				path.join(runDir, "status.json"),
				JSON.stringify({
					runId: "route-run",
					mode: "single",
					state: "running",
					pid: 1234,
					startedAt: Date.now(),
					lastUpdate: Date.now(),
					steps: [
						{
							childId: "route-run-0",
							description: "Review auth boundary",
							permissions: "read-only",
							agent: "Review auth boundary",
							status: "running",
						},
					],
				}),
			);
			const target = resolveAsyncResumeTarget(
				{ id: "route-run" },
				{ asyncDirRoot: asyncRoot, resultsDir: resultsRoot, kill: () => true },
				{ requireSessionFile: false },
			);
			expect(target.intercomTarget).toContain("route-run-0");
			expect(target.intercomTarget).not.toContain("review-auth-boundary");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps slash chain labels to generic descriptions and permissions", () => {
		const notifications: string[] = [];
		const built = buildChainExpressionSteps(
			{ baseCwd: process.cwd() } as never,
			'inspect[tier=light,permissions=read-only] "Find risks" -> implement[tier=standard] "Fix them"',
			{
				ui: {
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as never,
		);
		expect(notifications).toEqual([]);
		expect(built?.chain).toEqual([
			expect.objectContaining({ description: "inspect", permissions: "read-only", task: "Find risks" }),
			expect.objectContaining({ description: "implement", permissions: "full", task: "Fix them" }),
		]);
	});

	it("rejects dynamic descriptions that expand past the UI bound", () => {
		const step = {
			expand: { from: { output: "items", path: "/items" }, item: "item", maxItems: 1 },
			parallel: {
				task: "Review {item.name}",
				description: "Review {item.name}",
				permissions: "read-only",
				tier: "light",
			},
			collect: { as: "reviews" },
		};
		expect(() =>
			materializeDynamicParallelStep(
				step as never,
				{ items: { text: "", structured: { items: [{ name: "x".repeat(80) }] }, agent: "producer", stepIndex: 0 } },
				1,
			),
		).toThrow(DynamicFanoutError);
	});
});

describe("async recovery artifacts", () => {
	it("reads the v4 ChildSpec recovery contract", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-v4-"));
		try {
			fs.writeFileSync(
				path.join(dir, "recovery-descriptor.json"),
				JSON.stringify({
					version: 4,
					lifecycleArtifactVersion: 4,
					sourceRunId: "run-1",
					childId: "run-1-0",
					description: "Audit recovery path",
					permissions: "read-only",
					tier: "light",
					agent: "Audit recovery path",
					cwd: process.cwd(),
					outputMode: "inline",
					maxSubagentDepth: 1,
					share: false,
				}),
			);
			expect(readAsyncRecoveryDescriptor(dir)).toMatchObject({
				version: 4,
				childId: "run-1-0",
				description: "Audit recovery path",
				permissions: "read-only",
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects pre-cutover recovery descriptors instead of reviving ambiguously", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-v1-"));
		try {
			fs.writeFileSync(
				path.join(dir, "recovery-descriptor.json"),
				JSON.stringify({
					version: 1,
					sourceRunId: "run-1",
					agent: "reviewer",
					cwd: process.cwd(),
					outputMode: "inline",
					maxSubagentDepth: 1,
					share: false,
				}),
			);
			expect(() => readAsyncRecoveryDescriptor(dir)).toThrow(/version must be 4/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
