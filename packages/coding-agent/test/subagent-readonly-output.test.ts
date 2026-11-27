import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import {
	createSubagentExecutor,
	type SubagentParamsLike,
} from "../src/builtin-extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { resetPermissions } from "../src/core/permissions.ts";
import { createHarness } from "./suite/harness.ts";

// Every foreground child starts through runSync; a refused launch must never reach it.
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts")>();
	return {
		...actual,
		runSync: vi.fn(async (_cwd: string, _spec: unknown, _options: unknown) => ({
			agent: "probe",
			task: "review",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		})),
	};
});
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts")
		>();
	return { ...actual, isAsyncAvailable: () => true };
});

const model = "openai-codex/gpt-5.6-sol";
const availableModels = [
	{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: model, reasoning: true, thinkingLevelMap: { high: "high" } },
];

describe("subagent output in read-only mode", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-readonly-output-"));
		mkdirSync(join(root, "agent"));
		writeFileSync(join(root, "src.ts"), "original");
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

	function launch(params: SubagentParamsLike, sessionFile?: string) {
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
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" },
		} as never);
	}

	const child = (output?: string) => ({
		description: "probe",
		model,
		thinking: "high",
		permissions: "read-only",
		task: "review",
		output,
	});

	it("starts a child whose output stays in the run's directory", async () => {
		const result = await launch(child("review.md"));
		expect(JSON.stringify(result.content)).not.toContain("Read-only mode cannot");
		expect(runSync).toHaveBeenCalledTimes(1);
	});

	// The refusal is returned, not thrown, so only the loop's isError check makes it a failed call.
	it("reaches the model as a failed tool call", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "subagent",
					label: "subagent",
					description: "launch a child",
					parameters: Type.Object({}, { additionalProperties: true }),
					execute: () => launch(child(join(root, "src.ts"))),
				},
			],
		});
		let seen: ToolResultMessage | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", {})], { stopReason: "toolUse" }),
			(context) => {
				seen = context.messages.find((message): message is ToolResultMessage => message.role === "toolResult");
				return fauxAssistantMessage("done");
			},
		]);
		try {
			await harness.session.prompt("go");
		} finally {
			harness.cleanup();
		}
		expect(seen).toMatchObject({ isError: true });
		expect(JSON.stringify(seen?.content)).toContain("Read-only mode cannot");
	});

	// A saved session's file path is not the key its permission mode is stored under.
	it("refuses a project output when only the session is read-only and it has a session file", async () => {
		resetPermissions();
		resetPermissions("read-only", "test-session");
		const sessionFile = join(root, "agent", "sessions", "s.jsonl");
		const result = await launch(child(join(root, "src.ts")), sessionFile);
		expect(result).toMatchObject({ isError: true });
		const text = JSON.stringify(result.content);
		// Encoded like `text`, so a Windows path's backslashes match their escaped form.
		const runDir = JSON.stringify(
			`run's directory ${join(root, "agent", "sessions", "subagent-artifacts", "outputs")}`,
		);
		expect(text).toContain(runDir.slice(1, -1));
		expect(runSync).not.toHaveBeenCalled();
		expect(existsSync(join(root, ".pi-subagents"))).toBe(false);
	});

	it.each<[string, () => SubagentParamsLike]>([
		["single", () => child(join(root, "src.ts"))],
		["single with ..", () => child("../../../../src.ts")],
		["parallel", () => ({ tasks: [child("review.md"), child(join(root, "src.ts"))] })],
		["a later chain step", () => ({ chain: [child(), child(join(root, "src.ts"))] })],
		["a chain in the project", () => ({ chain: [child()], chainDir: join(root, "runs") })],
		["async chain without artifacts", () => ({ async: true, artifacts: false, chain: [child("src.ts")] })],
	])("refuses %s before any child starts", async (_shape, params) => {
		const result = await launch(params());
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result.content)).toContain("Read-only mode cannot");
		expect(runSync).not.toHaveBeenCalled();
		expect(readFileSync(join(root, "src.ts"), "utf-8")).toBe("original");
		expect(existsSync(join(root, "runs"))).toBe(false);
	});
});
