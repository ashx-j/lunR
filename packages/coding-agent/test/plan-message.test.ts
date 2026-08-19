import { describe, expect, it } from "vitest";
import { planMessageMarkdown } from "../src/modes/interactive/components/plan-message.ts";

describe("planMessageMarkdown", () => {
	it("keeps the full summary and does not slice at 500 chars", () => {
		const summary = `${"x".repeat(600)}\n\n## Steps\n1. one\n2. two`;
		expect(planMessageMarkdown(summary)).toBe(summary);
		expect(planMessageMarkdown(summary).length).toBeGreaterThan(500);
	});
});
