import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	collapseCompactThinkingText,
	compactRowLead,
	formatCompactThinkingHangLine,
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

describe("compact thinking hang line", () => {
	it("collapses newlines to a single line", () => {
		expect(collapseCompactThinkingText("line one\n\nline two")).toBe("line one line two");
	});

	it("falls back to thinking… when empty", () => {
		expect(collapseCompactThinkingText(undefined)).toBe("thinking…");
		expect(collapseCompactThinkingText("   ")).toBe("thinking…");
	});

	it("truncates to terminal width without wrapping", () => {
		const line = formatCompactThinkingHangLine("word ".repeat(80), 40);
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("renderSingleCompact thinking line", () => {
	const stubTheme = {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
		italic: (value: string) => value,
	};

	it("shows header stats and one truncated thinking line, not activity", () => {
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
		expect(lines[0]).toContain("thinking high");
		expect(lines[0]).toContain("worker");
		expect(lines[0]).toContain("52 tool uses");
		expect(lines[0]).toContain("172k token");
		expect(lines.some((line) => line.includes("Considering the next read of src/foo.ts"))).toBe(true);
		expect(lines.some((line) => /needs attention/i.test(line))).toBe(false);
		expect(lines.some((line) => /read:/.test(line))).toBe(false);
		expect(lines.filter((line) => line.includes("⎿"))).toHaveLength(1);
		expect(lines.length).toBe(2);
	});
});
