import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildAsyncRunnerSteps,
	executeAsyncChain,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
	createSubagentExecutor,
	type SubagentParamsLike,
} from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { MODEL_TIERS_BRIDGE_SYMBOL } from "../src/core/model-tiers.ts";
import { resetPermissions } from "../src/core/permissions.ts";

vi.mock("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts")
		>();
	return { ...actual, isAsyncAvailable: () => true, executeAsyncChain: vi.fn() };
});

const model = "openai-codex/gpt-5.6-sol";
const availableModels = [
	{
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		fullId: model,
		reasoning: true,
		thinkingLevelMap: { high: "high", low: "low" },
	},
];

const missingSelection =
	'Every executable child requires tier: "light", "standard", or "heavy", or an explicit model when the user names one.';

describe("parallel explicit model launch validation", () => {
	let root: string;
	let models = availableModels;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-parallel-model-"));
		models = availableModels;
		resetPermissions("auto");
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_") || key.startsWith("PI_INTERCOM_")) {
				vi.stubEnv(key, undefined);
			}
		}
		// Keep the real runner validation, replacing only background process dispatch.
		vi.mocked(executeAsyncChain).mockImplementation((id, params) => {
			const built = buildAsyncRunnerSteps(id, { ...params, asyncDir: root });
			if ("error" in built) {
				return {
					isError: true,
					content: [{ type: "text", text: built.error }],
					details: { mode: "parallel", results: [] },
				};
			}
			return {
				content: [{ type: "text", text: "Validated local dispatch" }],
				details: { mode: "parallel", results: [], runnerSteps: built.steps },
			};
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		resetPermissions();
		delete (globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL];
		rmSync(root, { recursive: true, force: true });
	});

	function children() {
		return ["Quiet tool cards and animated browser activity", "Copyable text boxes and concise agent guidance"].map(
			(description, index) => ({
				description,
				model,
				thinking: "high",
				cwd: join(root, `project-${index}`),
				task: "Implement the assigned change.",
			}),
		);
	}

	function launch(params: SubagentParamsLike) {
		const executor = createSubagentExecutor({
			pi: { getSessionName: () => "test-session", events: { emit() {} } } as never,
			state: {} as never,
			config: { intercomBridge: false } as never,
			tempArtifactsDir: root,
			getSubagentSessionRoot: () => root,
			expandTilde: (path) => path,
		});
		return executor.execute("test-call", params, new AbortController().signal, undefined, {
			cwd: root,
			hasUI: params.clarify === true,
			ui: {
				custom: async () => ({
					confirmed: true,
					runInBackground: true,
					templates: params.tasks?.map((task) => task.task),
					behaviorOverrides: [],
				}),
			},
			model: availableModels[0],
			modelRegistry: { getAvailable: () => models },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
		} as never);
	}

	it.each(["omitted async", "explicit async", "clarify to background", "chain parallel"])(
		"dispatches both explicit models with high thinking via %s",
		async (mode) => {
			const tasks = children();
			const params =
				mode === "chain parallel"
					? { chain: [{ parallel: tasks, concurrency: 2 }] }
					: {
							tasks,
							concurrency: 2,
							...(mode === "explicit async" ? { async: true } : {}),
							...(mode === "clarify to background" ? { clarify: true } : {}),
						};
			const result = await launch(params);
			expect(result.content).not.toEqual([{ type: "text", text: missingSelection }]);
			expect(result.isError).not.toBe(true);
			expect(vi.mocked(executeAsyncChain).mock.calls[0]?.[1].chain).toMatchObject([
				{ parallel: tasks.map(() => ({ model, thinking: "high" })), concurrency: 2 },
			]);
			expect(result.details).toMatchObject({
				runnerSteps: [
					{
						parallel: tasks.map((task) => ({
							description: task.description,
							cwd: task.cwd,
							model: `${model}:high`,
							thinking: "high",
							modelSelection: { kind: "model", model },
						})),
					},
				],
			});
		},
	);

	it.each([
		[{ model: undefined, thinking: undefined }, /Every executable child requires/],
		[{ tier: "light" }, /exactly one/],
		[{ model: "inherit" }, /inherit/],
		[{ model: "openai-codex/missing" }, /unavailable or unauthenticated/],
		[{ model: "" }, /Every executable child requires/],
		[{ thinking: "bogus" }, /thinking must be one of/],
		[{ thinking: "max" }, /Thinking level 'max' is not supported/],
		[{ model: undefined, tier: "light" }, /thinking is only valid with an explicit model/],
	])("rejects invalid child selection %j", async (override, error) => {
		const tasks = children();
		const result = await launch({ tasks: [tasks[0], { ...tasks[1], ...override }] });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(error) }]);
		expect(result.details).not.toHaveProperty("runnerSteps");
	});

	it("rejects unauthenticated models before dispatch", async () => {
		models = [];
		const result = await launch({ tasks: children() });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/no authenticated models/i) }]);
		expect(result.details).not.toHaveProperty("runnerSteps");
	});

	it("preserves per-child tier thinking beside an explicit model", async () => {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => true,
			getTierModel: () => model,
			getTierThinking: () => "low",
		};
		const tasks = children();
		const result = await launch({
			tasks: [tasks[0], { ...tasks[1], model: undefined, thinking: undefined, tier: "light" }],
		});
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({
			runnerSteps: [
				{
					parallel: [
						{ model: `${model}:high`, thinking: "high", modelSelection: { kind: "model", model } },
						{ model: `${model}:low`, thinking: "low", modelSelection: { kind: "tier", tier: "light" } },
					],
				},
			],
		});
	});

	it("keeps plan launches restricted to explicit read-only children", async () => {
		resetPermissions("plan");
		const denied = await launch({ tasks: children() });
		expect(denied.isError).toBe(true);
		expect(executeAsyncChain).not.toHaveBeenCalled();
		const allowed = await launch({ tasks: children().map((task) => ({ ...task, permissions: "read-only" })) });
		expect(allowed.isError).not.toBe(true);
		expect(allowed.details).toMatchObject({
			runnerSteps: [
				{
					parallel: [
						{ permissions: "read-only", model: `${model}:high` },
						{ permissions: "read-only", model: `${model}:high` },
					],
				},
			],
		});
	});
});
