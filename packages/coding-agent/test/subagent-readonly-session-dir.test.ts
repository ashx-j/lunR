import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { createSubagentExecutor } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { resetPermissions } from "../src/core/permissions.ts";

// A refused launch must never reach a child, and a missed refusal must not spawn a real one.
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts")>();
	return {
		...actual,
		runSync: vi.fn(async () => ({
			agent: "probe",
			task: "review",
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

describe("subagent sessionDir in read-only mode", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-readonly-sessiondir-"));
		mkdirSync(join(root, "agent"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_") || key.startsWith("PI_INTERCOM_")) {
				vi.stubEnv(key, undefined);
			}
		}
		resetPermissions("read-only");
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		resetPermissions();
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses a sessionDir before it creates anything", async () => {
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
		const sessionDir = join(root, "src");
		const result = await executor.execute(
			"test-call",
			{
				async: false,
				description: "probe",
				model,
				thinking: "high",
				permissions: "read-only",
				task: "review",
				sessionDir,
			},
			new AbortController().signal,
			undefined,
			{
				cwd: root,
				hasUI: false,
				model: availableModels[0],
				modelRegistry: { getAvailable: () => availableModels },
				sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
			} as never,
		);
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result.content)).toContain("Leave sessionDir unset");
		expect(runSync).not.toHaveBeenCalled();
		expect(existsSync(sessionDir)).toBe(false);
	});
});
