import { describe, expect, it } from "vitest";
import { buildInjectedContextLines } from "../src/modes/interactive/injected-context.ts";

describe("buildInjectedContextLines", () => {
	it("returns an injected context card for loaded files", () => {
		expect(buildInjectedContextLines(["AGENTS.md", "~/.lunr/agent/agents/AGENTS.md"])).toEqual([
			"injected context",
			"  AGENTS.md",
			"  ~/.lunr/agent/agents/AGENTS.md",
		]);
	});

	it("returns nothing when no context files are loaded", () => {
		expect(buildInjectedContextLines([])).toEqual([]);
		expect(buildInjectedContextLines(["  "])).toEqual([]);
	});
});
