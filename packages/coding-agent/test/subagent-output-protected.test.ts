import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
	return { ...actual, runSync: vi.fn() };
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
			state: { foregroundControls: new Map() } as never,
			config: { intercomBridge: false } as never,
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

	it.each([
		["single", () => child(join(agentDir, "settings.json"))],
		["parallel", () => ({ tasks: [child(join(agentDir, "settings.json"))] })],
		["a later chain step", () => ({ chain: [child(), child(join(agentDir, "gateway.json"))] })],
	])("refuses %s before any child starts", async (_shape, params) => {
		const result = await launch(params() as SubagentParamsLike);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Subagent output can't go to");
		expect(runSync).not.toHaveBeenCalled();
	});
});
