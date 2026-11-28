import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// A bash call through a real AgentSession: the tool-call hooks add the tracker's result for the
// model and the card. Moving the hooks once dropped this without any test noticing.
describe("AgentSession bash file changes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return { harness };
	}

	it("adds the files a bash call changed to its result for the model and the card", async () => {
		const { harness } = await start();
		const git = (command: string) => execSync(`git ${command}`, { cwd: harness.tempDir, stdio: "pipe" });
		writeFileSync(join(harness.tempDir, "f.txt"), "a\n");
		git("init -q -b main");
		git("-c user.email=t@example.com -c user.name=t add f.txt");
		git("-c user.email=t@example.com -c user.name=t commit -qm init");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo b >> f.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(getMessageText(result)).toContain("Files changed: f.txt (modified +1)");
		const end = harness.eventsOfType("tool_execution_end")[0];
		expect(end.result.details?.fileChanges?.files).toEqual([
			expect.objectContaining({ path: "f.txt", kind: "modified", added: 1, removed: 0 }),
		]);
	});
});
