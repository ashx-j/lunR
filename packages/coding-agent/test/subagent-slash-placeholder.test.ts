import { expect, it } from "vitest";
import { buildSlashInitialResult } from "../src/builtin-extensions/pi-subagents/src/slash/slash-live-state.ts";

it("labels prompt-driven slash placeholders by their description", () => {
	const chain = buildSlashInitialResult("chain", {
		chain: [
			{ description: "Scan repo", permissions: "read-only", tier: "light", task: "scan" },
			{ parallel: [{ description: "Fix it", permissions: "full", tier: "light" }] },
		],
	}).result;
	expect(chain.content[0]).toMatchObject({ text: "Step 1: Scan repo\nscan\n\nStep 2: Fix it\n" });
	expect(chain.details?.chainAgents).toEqual(["Scan repo", "[Fix it]"]);

	const parallel = buildSlashInitialResult("parallel", {
		tasks: [{ description: "Read docs", permissions: "read-only", tier: "light", task: "read" }],
	}).result;
	expect(parallel.content[0]).toMatchObject({ text: "Read docs: read" });
	expect(parallel.details?.progress?.[0]?.agent).toBe("Read docs");
});
