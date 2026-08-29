import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import simpleMemory from "../src/builtin-extensions/simple-pi-memory.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { MEMORY_CAP_BRIDGE_SYMBOL, registerMemoryCapBridge } from "../src/core/memory-cap.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedTool {
	name: string;
	description: string;
	execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text: string }> }>;
}

describe("agent-managed factual memory", () => {
	let root: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-agent-memory-"));
		agentDir = join(root, ".lunr", "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		delete (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL];
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("injects only while enabled and rejects tool execution after disable", async () => {
		const manager = SettingsManager.create(root, agentDir);
		registerMemoryCapBridge(manager);
		const memoryDir = join(dirname(agentDir), "simple-memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "memory.md"), "[2026-08-29] User prefers tabs.\n", "utf-8");

		const tools: CapturedTool[] = [];
		let beforeStart:
			| ((event: {
					type: "before_agent_start";
					systemPrompt: string;
			  }) => Promise<{ systemPrompt?: string } | undefined>)
			| undefined;
		const api = {
			registerTool(tool: CapturedTool) {
				tools.push(tool);
			},
			registerCommand() {},
			on(_event: "before_agent_start", handler: typeof beforeStart) {
				beforeStart = handler;
			},
		};
		simpleMemory(api as never);

		expect(tools.map((tool) => tool.name)).toEqual(["memory_add", "memory_remove", "memory_load"]);
		expect(tools.find((tool) => tool.name === "memory_add")?.description).toContain("durable fact");
		expect(tools.find((tool) => tool.name === "memory_add")?.description).toContain("never behavior instructions");
		const enabledPrompt = await beforeStart?.({ type: "before_agent_start", systemPrompt: "base" });
		expect(enabledPrompt?.systemPrompt).toContain("User prefers tabs.");

		manager.setMemoryEnabled(false);
		expect(await beforeStart?.({ type: "before_agent_start", systemPrompt: "base" })).toBeUndefined();
		const result = await tools[0].execute(
			"call",
			{ content: "new fact" },
			new AbortController().signal,
			undefined,
			{},
		);
		expect(result.content[0]?.text).toBe("Agent memory is disabled in /settings.");
	});
});
