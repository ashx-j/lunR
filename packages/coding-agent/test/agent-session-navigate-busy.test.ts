import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-harness.ts";

describe("AgentSession.navigateTree during a run", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("rejects while a run is active and leaves the leaf in place", async () => {
		let started = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release = () => {};
		const toolReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Blocks until released",
			parameters: Type.Object({}),
			execute: async () => {
				started();
				await toolReleased;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		harness = await createHarness({
			responses: ["first", { toolCalls: [{ name: "wait", args: {} }] }, "done"],
			tools: [waitTool],
			baseToolsOverride: { wait: waitTool },
		});
		const { session } = harness;
		const { sessionManager } = session;

		await session.prompt("one");
		const target = sessionManager.getEntries()[0];
		const running = session.prompt("two");
		await toolStarted;
		const leafDuringRun = sessionManager.getLeafId();

		await expect(session.navigateTree(target.id)).rejects.toThrow("Wait for the current response to finish");
		expect(sessionManager.getLeafId()).toBe(leafDuringRun);

		release();
		await running;
		await expect(session.navigateTree(target.id)).resolves.toMatchObject({ cancelled: false });
	});
});
