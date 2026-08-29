import { beforeEach, describe, expect, it } from "vitest";
import { computeContextBreakdown } from "../src/core/context-breakdown.ts";
import { renderUsageBox } from "../src/modes/interactive/components/usage-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("moon");
});

/** Strip ANSI codes so assertions can match plain text. */
function plain(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderUsageBox", () => {
	it("renders simple session totals without model names", () => {
		const out = plain(
			renderUsageBox(
				{
					sessionTotals: { input: 12000, output: 3000, cacheRead: 4000, cacheWrite: 0, total: 19000 },
					context: undefined,
					plan: [],
				},
				80,
			),
		);
		expect(out).toContain("Session usage");
		expect(out).toContain("input 12k");
		expect(out).toContain("output 3.0k");
		expect(out).toContain("total 19k");
		expect(out).toContain("cached 4.0k (25%)");
		expect(out).not.toContain("kimi-code/");
	});

	it("omits the session section when totals are zero or missing", () => {
		const zero = plain(
			renderUsageBox({ sessionTotals: { input: 0, output: 0, total: 0 }, context: undefined, plan: [] }, 80),
		);
		expect(zero).toContain("No usage data yet.");
		const missing = plain(renderUsageBox({ sessionTotals: undefined, context: undefined, plan: [] }, 80));
		expect(missing).toContain("No usage data yet.");
	});

	it("does not render a Last 30 days section", () => {
		const out = plain(
			renderUsageBox(
				{
					sessionTotals: { input: 100, output: 20, total: 120 },
					context: undefined,
					plan: [],
				},
				80,
			),
		);
		expect(out).not.toContain("Last 30 days");
	});

	it("renders a Context section with system prompt and an AGENTS.md row", () => {
		const prompt = [
			"You are an expert coding assistant.",
			"",
			"<project_context>",
			"",
			'<project_instructions path="C:/repo/AGENTS.md">',
			"Use exact verbs.",
			"</project_instructions>",
			"",
			"</project_context>",
		].join("\n");
		const breakdown = computeContextBreakdown({
			systemPrompt: prompt,
			tools: [],
			messages: [],
			contextWindow: 200_000,
		});
		const out = plain(
			renderUsageBox(
				{
					sessionTotals: undefined,
					context: { tokens: 10, contextWindow: 200_000, percent: 1 },
					plan: [],
					breakdown,
				},
				80,
			),
		);
		expect(out).toContain("Context");
		expect(out).toContain("System prompt");
		expect(out).toContain("AGENTS.md");
		expect(out).not.toContain("Last 30 days");
		expect(out).not.toContain("System prompt + files");
	});
});
