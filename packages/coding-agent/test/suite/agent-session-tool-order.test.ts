import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession tool call order", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("flags only calls that can change state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const mutates = (name: string, args: Record<string, unknown>) =>
			harness.session.agent.toolCallMutates?.({ type: "toolCall", id: name, name, arguments: args }, args);

		expect(mutates("read", { path: "a.txt" })).toBe(false);
		expect(mutates("bash", { command: "cat a.txt | head -5" })).toBe(false);
		expect(mutates("bash", { command: "echo data > a.txt" })).toBe(true);
		expect(mutates("write", { path: "a.txt", content: "x" })).toBe(true);
		expect(mutates("edit", { path: "a.txt", edits: [] })).toBe(true);
	});

	it("runs a bash read after an earlier bash write in the same message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 0.2; echo data > order.txt" }),
					fauxToolCall("bash", { command: "cat order.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => result.isError)).toEqual([false, false]);
		expect(getMessageText(results[1])).toContain("data");
	});
});
