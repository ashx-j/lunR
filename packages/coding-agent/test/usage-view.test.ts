import { beforeEach, describe, expect, it } from "vitest";
import type { UsageHistory } from "../src/core/usage-history.ts";
import { renderTokenUsageBox, renderUsageBox } from "../src/modes/interactive/components/usage-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("moon");
});

function makeHistory(overrides: Partial<UsageHistory> = {}): UsageHistory {
	return {
		perModel: [],
		perDay: [],
		categories: { user: 0, assistantText: 0, thinking: 0, toolCalls: 0, toolResults: 0, summaries: 0, total: 0 },
		includesSystemPrompt: false,
		filesScanned: 0,
		filesParsed: 0,
		sessionsWithUsage: 0,
		...overrides,
	};
}

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
					plan: undefined,
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
			renderUsageBox({ sessionTotals: { input: 0, output: 0, total: 0 }, context: undefined, plan: undefined }, 80),
		);
		expect(zero).toContain("No usage data yet.");
		const missing = plain(renderUsageBox({ sessionTotals: undefined, context: undefined, plan: undefined }, 80));
		expect(missing).toContain("No usage data yet.");
	});

	it("renders a 30-day aggregate total without per-model rows", () => {
		const history = makeHistory({
			perModel: [
				{ model: "kimi-coding/k2", input: 1000, output: 500, cacheRead: 100, cacheWrite: 0, total: 1600 },
				{ model: "openai-codex/gpt-5.3", input: 2000, output: 400, cacheRead: 0, cacheWrite: 0, total: 2400 },
			],
			filesScanned: 2,
			sessionsWithUsage: 2,
		});
		const out = plain(renderUsageBox({ sessionTotals: undefined, context: undefined, plan: undefined, history }, 80));
		expect(out).toContain("Last 30 days");
		// input stays uncached (1000+2000); cacheRead 100 → cached 100 (3%)
		expect(out).toContain("input 3.0k");
		expect(out).toContain("output 900");
		expect(out).toContain("total 4.0k");
		expect(out).toContain("cached 100 (3%)");
		expect(out).not.toContain("kimi-coding/k2");
		expect(out).not.toContain("openai-codex/gpt-5.3");
	});

	it("renders the estimated category breakdown with the system-prompt note", () => {
		const history = makeHistory({
			categories: {
				user: 400,
				assistantText: 400,
				thinking: 0,
				toolCalls: 0,
				toolResults: 200,
				summaries: 0,
				total: 1000,
			},
		});
		const out = plain(renderUsageBox({ sessionTotals: undefined, context: undefined, plan: undefined, history }, 80));
		expect(out).toContain("Last 30 days by category");
		expect(out).toContain("User messages");
		expect(out).toContain("Tool results");
		expect(out).not.toContain("Thinking"); // zero-token categories are hidden
		expect(out).toContain("system prompt/tools not stored per session");
	});
});

describe("renderTokenUsageBox", () => {
	it("renders per-model session rows", () => {
		const out = plain(
			renderTokenUsageBox(
				{
					sessionRows: [
						{ model: "kimi-coding/k2", input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0, total: 15000 },
					],
				},
				80,
			),
		);
		expect(out).toContain("Session");
		expect(out).toContain("kimi-coding/k2");
		expect(out).toContain("input 12k");
	});

	it("filters out zero-token rows", () => {
		const out = plain(
			renderTokenUsageBox(
				{
					sessionRows: [
						{ model: "kimi-coding/k2", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						{ model: "zai/glm-5.2", input: 500, output: 100, cacheRead: 0, cacheWrite: 0, total: 600 },
					],
					history: makeHistory({
						perModel: [{ model: "xai/grok-4", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }],
					}),
				},
				80,
			),
		);
		expect(out).not.toContain("kimi-coding/k2");
		expect(out).not.toContain("xai/grok-4");
		expect(out).toContain("zai/glm-5.2");
	});

	it("renders 30-day per-model rows with a cache hit-rate suffix", () => {
		const history = makeHistory({
			perModel: [{ model: "kimi-coding/k2", input: 1000, output: 500, cacheRead: 100, cacheWrite: 0, total: 1600 }],
			sessionsWithUsage: 1,
		});
		const out = plain(renderTokenUsageBox({ sessionRows: [], history }, 80));
		expect(out).toContain("Last 30 days");
		expect(out).toContain("kimi-coding/k2");
		expect(out).toContain("input 1.0k");
		expect(out).toContain("cached 100 (9%)");
	});

	it("renders the empty state when nothing has usage", () => {
		const out = plain(renderTokenUsageBox({ sessionRows: [] }, 80));
		expect(out).toContain("No token usage yet.");
	});
});
