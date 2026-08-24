import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	compactRowLead,
	formatCompactStatsHangLine,
	renderSubagentResult,
	stripTaskChrome,
} from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";

describe("stripTaskChrome", () => {
	it("drops leading Read from / Write to lines", () => {
		expect(stripTaskChrome("[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
		expect(stripTaskChrome("[Write to: C:\\out]\n[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
	});
});

describe("compactRowLead", () => {
	it("prefers the model over Read from chrome", () => {
		expect(
			compactRowLead({
				task: "[Read from: C:\\foo]\nDo the work",
				model: "xai/grok-4:high",
			}),
		).toBe("grok-4");
	});

	it("never returns the path when there is no model", () => {
		expect(compactRowLead({ task: "[Read from: C:\\foo]" })).toBe("");
	});

	it("falls back to the truncated first line of a normal task", () => {
		expect(compactRowLead({ task: "Review the compact row helper" })).toBe("Review the compact row helper");
	});
});

describe("compact stats hang line", () => {
	it("prints tool count, tokens, and elapsed time", () => {
		expect(
			formatCompactStatsHangLine({
				toolCount: 52,
				tokens: 172000,
				durationMs: 9 * 60_000 + 56_000,
			}, 80),
		).toBe("  ⎿  52 tool uses · 172k token · 9m56s");
	});

	it("falls back to zeros when progress is empty", () => {
		expect(formatCompactStatsHangLine(undefined, 80)).toBe("  ⎿  0 tool uses · 0 token · 0ms");
	});

	it("truncates to terminal width without wrapping", () => {
		const line = formatCompactStatsHangLine(
			{ toolCount: 12, tokens: 999999, durationMs: 12_000 },
			20,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("renderSingleCompact thinking line", () => {
	const stubTheme = {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
		italic: (value: string) => value,
	};

	it("shows header model plus one stats hang line, not thinking text", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "worker",
							task: "do the work",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							model: "xai/grok-4.5",
							thinking: "high",
							progress: {
								index: 0,
								agent: "worker",
								status: "running",
								task: "do the work",
								model: "xai/grok-4.5",
								thinking: "high",
								thinkingText: "Considering\nthe next\nread of src/foo.ts",
								activityState: "needs_attention",
								currentTool: "read",
								currentToolArgs: "src/foo.ts",
								recentTools: [],
								recentOutput: [],
								toolCount: 52,
								tokens: 172000,
								durationMs: 9 * 60_000 + 56_000,
							},
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
		);
		const lines = result.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(lines[0]).toContain("grok-4.5");
		expect(lines[0]).not.toContain("thinking high");
		expect(lines[0]).toContain("worker");
		expect(lines[0]).toContain("52 tool uses");
		expect(lines[0]).toContain("172k token");
		expect(lines.some((line) => line.includes("Considering the next read of src/foo.ts"))).toBe(false);
		expect(lines.some((line) => /needs attention/i.test(line))).toBe(false);
		expect(lines.some((line) => /read:/.test(line))).toBe(false);
		expect(lines.filter((line) => line.includes("⎿"))).toHaveLength(1);
		expect(lines[1]).toContain("52 tool uses");
		expect(lines[1]).toContain("172k token");
		expect(lines[1]).toContain("9m56s");
		expect(lines.length).toBe(2);
	});
});
