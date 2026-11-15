import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import {
	createSubagentExecutor,
	type SubagentParamsLike,
} from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { resetPermissions } from "../src/core/permissions.ts";

// Every foreground child starts through runSync; a refused launch must never reach it.
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts")>();
	return {
		...actual,
		runSync: vi.fn(async (_cwd: string, _agents: unknown, agent: string, task: string) => ({
			agent,
			task,
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		})),
	};
});

const model = "openai-codex/gpt-5.6-sol";
const availableModels = [
	{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: model, reasoning: true, thinkingLevelMap: { high: "high" } },
];

describe("subagent output to a protected target", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-output-protected-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_") || key.startsWith("PI_INTERCOM_")) {
				vi.stubEnv(key, undefined);
			}
		}
		resetPermissions("yolo");
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		resetPermissions();
		rmSync(root, { recursive: true, force: true });
	});

	function launch(params: SubagentParamsLike) {
		const executor = createSubagentExecutor({
			pi: { getSessionName: () => "test-session", events: { emit() {} } } as never,
			state: {
				baseCwd: root,
				currentSessionId: null,
				foregroundSubagentInFlight: 0,
				subagentSpawns: { sessionId: null, count: 0 },
				asyncJobs: new Map(),
				foregroundRuns: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
				pendingForegroundControlNotices: new Map(),
				cleanupTimers: new Map(),
				lastUiContext: null,
				poller: null,
				completionSeen: new Map(),
				watcher: null,
				watcherRestartTimer: null,
				resultFileCoalescer: { schedule: () => false, clear: () => {} },
			},
			config: { intercomBridge: { mode: "off" } },
			tempArtifactsDir: root,
			getSubagentSessionRoot: () => root,
			expandTilde: (path) => path,
		});
		return executor.execute("test-call", { async: false, ...params }, new AbortController().signal, undefined, {
			cwd: root,
			hasUI: false,
			model: availableModels[0],
			modelRegistry: { getAvailable: () => availableModels },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
		} as never);
	}

	const child = (output?: string) => ({ description: "probe", model, thinking: "high", task: "say hi", output });

	it("starts a child for an output inside the project", async () => {
		const result = await launch(child(join(root, "report.md")));
		expect(JSON.stringify(result.content)).not.toContain("Subagent output can't go to");
		expect(runSync).toHaveBeenCalledTimes(1);
	});

	it.each<[string, () => SubagentParamsLike]>([
		["single", () => child(join(agentDir, "settings.json"))],
		["parallel", () => ({ tasks: [child(join(agentDir, "settings.json"))] })],
		[
			"a later chain step",
			() => ({ chain: [child(), child(join(agentDir, "gateway.json"))], chainDir: join(root, "chains") }),
		],
	])("refuses %s before any child starts", async (_shape, params) => {
		const result = await launch(params());
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result.content)).toContain("Subagent output can't go to");
		expect(runSync).not.toHaveBeenCalled();
		expect(existsSync(join(root, "chains"))).toBe(false);
	});
});
