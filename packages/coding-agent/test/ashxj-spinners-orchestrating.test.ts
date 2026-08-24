import { describe, expect, it } from "vitest";
import { composeWorkingMessage } from "../src/builtin-extensions/ashxj-spinners.ts";

describe("composeWorkingMessage", () => {
	it("returns the kaomoji alone", () => {
		expect(composeWorkingMessage("(ᵕ—ᴗ—)")).toBe("(ᵕ—ᴗ—)");
		expect(composeWorkingMessage("")).toBe("");
	});

	it("does not prefix Orchestrating…", () => {
		expect(composeWorkingMessage("(ᵕ—ᴗ—)")).not.toContain("Orchestrating");
	});
});
