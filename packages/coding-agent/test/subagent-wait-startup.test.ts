import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerWaitTool } from "../src/builtin-extensions/pi-subagents/src/runs/background/wait-tool.ts";
import type { SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

describe("subagent_wait startup ordering", () => {
	it("waits for same-batch launches to register before taking its run snapshot", async () => {
		let release!: () => void;
		const launchBarrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | undefined;
		const pi = {
			events: { on: () => () => {} },
			registerTool(value: typeof tool) {
				tool = value;
			},
		};
		const state = {
			currentSessionId: `wait-startup-${randomUUID()}`,
			foregroundRuns: new Map(),
		} as unknown as SubagentState;
		let siblingStarted = false;
		registerWaitTool(pi as never, state, true, async () => {
			expect(siblingStarted).toBe(true);
			await launchBarrier;
		});

		let settled = false;
		const pending = tool!.execute("wait", {}, undefined).then((result) => {
			settled = true;
			return result;
		});
		siblingStarted = true;
		await Promise.resolve();
		expect(settled).toBe(false);

		release();
		const result = await pending;
		expect(result.content[0]?.text).toContain("Nothing to wait for");
	});
});
