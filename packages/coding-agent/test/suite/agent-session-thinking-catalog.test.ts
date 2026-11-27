import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession thinking level after a catalog refresh", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps the saved default when the refreshed catalog marks the session model non-reasoning", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", name: "One", reasoning: true }] });
		harnesses.push(harness);
		const { session } = harness;
		session.setThinkingLevel("medium");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");

		// The session still holds the reasoning object; the registry copy now says it does not reason.
		const stale = session.model;
		if (!stale) throw new Error("harness has no model");
		vi.spyOn(session.modelRuntime, "getModel").mockReturnValue({ ...stale, reasoning: false });

		session.setThinkingLevel("high");
		expect(session.thinkingLevel).toBe("off");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});
});
