import { describe, expect, it } from "vitest";
import { compactRowLead, stripTaskChrome } from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";

describe("stripTaskChrome", () => {
	it("drops leading Read from / Write to lines", () => {
		expect(stripTaskChrome("[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
		expect(stripTaskChrome("[Write to: C:\\out]\n[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
	});
});

describe("compactRowLead", () => {
	it("prefers model + thinking over Read from chrome", () => {
		expect(
			compactRowLead({
				task: "[Read from: C:\\foo]\nDo the work",
				model: "xai/grok-4:high",
			}),
		).toBe("grok-4 · thinking high");
	});

	it("never returns the path when there is no model", () => {
		expect(compactRowLead({ task: "[Read from: C:\\foo]" })).toBe("");
	});

	it("falls back to the truncated first line of a normal task", () => {
		expect(compactRowLead({ task: "Review the compact row helper" })).toBe("Review the compact row helper");
	});
});
