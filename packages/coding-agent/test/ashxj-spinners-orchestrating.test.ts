import { describe, expect, it } from "vitest";
import {
	composeWorkingMessage,
	isSubagentToolName,
} from "../src/builtin-extensions/ashxj-spinners.ts";

describe("composeWorkingMessage", () => {
	it("returns the kaomoji alone when not orchestrating", () => {
		expect(composeWorkingMessage("(ᵕ—ᴗ—)", false)).toBe("(ᵕ—ᴗ—)");
		expect(composeWorkingMessage("", false)).toBe("");
	});

	it("prefixes Orchestrating… before the kaomoji", () => {
		expect(composeWorkingMessage("(ᵕ—ᴗ—)", true)).toBe("Orchestrating… (ᵕ—ᴗ—)");
	});

	it("uses Orchestrating… alone when the kaomoji is empty", () => {
		expect(composeWorkingMessage("", true)).toBe("Orchestrating…");
	});
});

describe("isSubagentToolName", () => {
	it("matches subagent and subagent_wait only", () => {
		expect(isSubagentToolName("subagent")).toBe(true);
		expect(isSubagentToolName("subagent_wait")).toBe(true);
		expect(isSubagentToolName("read")).toBe(false);
		expect(isSubagentToolName("bash")).toBe(false);
		expect(isSubagentToolName(undefined)).toBe(false);
	});
});
