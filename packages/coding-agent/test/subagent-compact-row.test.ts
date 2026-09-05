import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAsyncRunList } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-status.ts";
import { formatModelSelection } from "../src/builtin-extensions/pi-subagents/src/shared/formatters.ts";
import { SubagentFleetComponent } from "../src/builtin-extensions/pi-subagents/src/tui/fleet.ts";
import {
	buildWidgetLines,
	compactRowLead,
	formatCompactStatsHangLine,
	renderSubagentResult,
	stripTaskChrome,
	subagentAnimSink,
} from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";

afterEach(() => {
	subagentAnimSink.current = null;
	vi.useRealTimers();
});

describe("stripTaskChrome", () => {
	it("drops leading Read from / Write to lines", () => {
		expect(stripTaskChrome("[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
		expect(stripTaskChrome("[Write to: C:\\out]\n[Read from: C:\\foo]\nDo the work")).toBe("Do the work");
	});
});

describe("compactRowLead", () => {
	it("uses description as the primary label", () => {
		expect(
			compactRowLead({
				description: "Search auth flow for bugs",
				task: "[Read from: C:\\foo]\nDo the work",
				model: "xai/grok-4:high",
			}),
		).toBe("Search auth flow for bugs");
	});

	it("never returns a model or path when description is missing", () => {
		expect(compactRowLead({ task: "[Read from: C:\\foo]", model: "xai/grok-4:high" })).toBe("");
	});

	it("falls back to the truncated first line of a normal task", () => {
		expect(compactRowLead({ task: "Review the compact row helper" })).toBe("Review the compact row helper");
	});
});

describe("compact stats hang line", () => {
	it("prints tool count, tokens, and elapsed time", () => {
		expect(
			formatCompactStatsHangLine(
				{
					toolCount: 52,
					tokens: 172000,
					durationMs: 9 * 60_000 + 56_000,
				},
				80,
			),
		).toBe("  ⎿  52 tool uses · 172k token · 9m56s");
	});

	it("falls back to zeros when progress is empty", () => {
		expect(formatCompactStatsHangLine(undefined, 80)).toBe("  ⎿  0 tool uses · 0 token · 0ms");
	});

	it("truncates to terminal width without wrapping", () => {
		const line = formatCompactStatsHangLine({ toolCount: 12, tokens: 999999, durationMs: 12_000 }, 20);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line.split("\n")).toHaveLength(1);
	});

	it("advances running time in whole seconds and freezes a terminal duration", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const progress = { toolCount: 1, tokens: 10, durationMs: 1_500, lastActivityAt: 10_000 };
		expect(formatCompactStatsHangLine(progress, 80, (text) => text, "  ⎿  ", Date.now(), true)).toContain("1s");
		vi.advanceTimersByTime(1_000);
		expect(formatCompactStatsHangLine(progress, 80, (text) => text, "  ⎿  ", Date.now(), true)).toContain("2s");
		vi.advanceTimersByTime(1_000);
		const running = formatCompactStatsHangLine(progress, 80, (text) => text, "  ⎿  ", Date.now(), true);
		expect(running).toContain("3s");
		expect(running).not.toMatch(/\d+\.\d+s/);
		expect(formatCompactStatsHangLine(progress, 80, (text) => text, "  ⎿  ", Date.now(), false)).toContain("1s");
	});
});

describe("async widget, fleet, and status timing", () => {
	const theme = {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
		italic: (value: string) => value,
	};

	it("uses a live render clock and freezes terminal async durations", () => {
		vi.useFakeTimers();
		vi.setSystemTime(12_000);
		const job = {
			asyncId: "timer-run",
			asyncDir: "Z:/missing/timer-run",
			status: "running",
			mode: "single",
			agents: ["Check timer"],
			startedAt: 10_000,
			updatedAt: 10_000,
			toolCount: 1,
		};
		expect(buildWidgetLines([job] as never, theme as never, 120).join("\n")).toContain("2s");
		vi.advanceTimersByTime(1_000);
		expect(buildWidgetLines([job] as never, theme as never, 120).join("\n")).toContain("3s");

		job.status = "complete";
		job.updatedAt = 12_000;
		const terminal = buildWidgetLines([job] as never, theme as never, 120).join("\n");
		vi.advanceTimersByTime(5_000);
		expect(terminal).toContain("ran for 2s");
		expect(buildWidgetLines([job] as never, theme as never, 120).join("\n")).toBe(terminal);
	});

	it("uses ran for in terminal status and fleet rows", () => {
		vi.useFakeTimers();
		vi.setSystemTime(20_000);
		const run = {
			id: "timer-run",
			asyncDir: "Z:/missing/timer-run",
			state: "complete",
			mode: "single",
			startedAt: 10_000,
			lastUpdate: 12_000,
			steps: [{ index: 0, agent: "Check timer", status: "complete", durationMs: 2_000 }],
		};
		expect(formatAsyncRunList([run] as never)).toContain("ran for 2s");

		const state = {
			currentSessionId: null,
			asyncJobs: new Map(),
			fleetJobs: new Map([
				[
					"timer-run",
					{
						asyncId: "timer-run",
						asyncDir: "Z:/missing/timer-run",
						status: "complete",
						mode: "single",
						agents: ["T"],
						startedAt: 10_000,
						updatedAt: 12_000,
					},
				],
			]),
			foregroundControls: new Map(),
			foregroundRuns: new Map(),
		};
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 32 }, requestRender() {} } as never,
			theme as never,
			state as never,
			() => {},
			{ refreshMs: 1_000 },
		);
		try {
			expect(component.render(140).join("\n")).toContain("ran for 2s");
		} finally {
			component.dispose();
		}
	});
});

describe("renderSingleCompact thinking line", () => {
	const stubTheme = {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
		italic: (value: string) => value,
	};

	it("registers live clock lines and terminal rows say ran for a frozen duration", () => {
		vi.useFakeTimers();
		vi.setSystemTime(20_000);
		const makeResult = (status: "running" | "completed") => ({
			content: [{ type: "text", text: status }],
			details: {
				mode: "single",
				results: [
					{
						description: "Check timer",
						permissions: "read-only",
						task: "check time",
						exitCode: 0,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						progress:
							status === "running"
								? {
										index: 0,
										status,
										task: "check time",
										recentTools: [],
										recentOutput: [],
										toolCount: 1,
										tokens: 10,
										durationMs: 2_000,
										lastActivityAt: 20_000,
									}
								: undefined,
						progressSummary:
							status === "completed"
								? {
										index: 0,
										status,
										task: "check time",
										recentTools: [],
										recentOutput: [],
										toolCount: 1,
										tokens: 10,
										durationMs: 2_000,
										lastActivityAt: 20_000,
									}
								: undefined,
					},
				],
			},
		});

		subagentAnimSink.current = [];
		const live = renderSubagentResult(makeResult("running") as never, { expanded: false }, stubTheme, 0);
		expect(subagentAnimSink.current).toHaveLength(2);
		vi.advanceTimersByTime(1_000);
		for (const entry of subagentAnimSink.current ?? []) entry.text.setText(entry.line(1, Date.now()));
		expect(live.render(120).join("\n")).toContain("3s");

		subagentAnimSink.current = [];
		const terminal = renderSubagentResult(makeResult("completed") as never, { expanded: false }, stubTheme, 0);
		const first = terminal.render(120).join("\n");
		vi.advanceTimersByTime(5_000);
		const later = terminal.render(120).join("\n");
		expect(first).toContain("ran for 2s");
		expect(later).toBe(first);
		expect(subagentAnimSink.current).toHaveLength(0);
	});

	it("shows description-first header plus one stats hang line, not thinking text", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [
						{
							description: "Search auth flow for bugs",
							permissions: "read-only",
							task: "do the work",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							model: "xai/grok-4.5",
							thinking: "high",
							progress: {
								index: 0,
								description: "Search auth flow for bugs",
								permissions: "read-only",
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
		expect(lines[0]).toContain("Search auth flow for bugs");
		expect(lines[0]).toContain("grok-4.5");
		expect(lines[0]).not.toContain("worker");
		expect(lines[0]).not.toContain("scout");
		expect(lines.some((line) => line.includes("Considering the next read of src/foo.ts"))).toBe(false);
		expect(lines.some((line) => /needs attention/i.test(line))).toBe(false);
		expect(lines.some((line) => /read:/.test(line))).toBe(false);
		expect(lines.filter((line) => line.includes("⎿"))).toHaveLength(1);
		expect(lines[1]).toContain("52 tool uses");
		expect(lines[1]).toContain("172k token");
		expect(lines[1]).toContain("9m56s");
		expect(lines.length).toBe(2);
	});

	it("shows the selected tier instead of the resolved model", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [
						{
							description: "Search auth flow for bugs",
							permissions: "read-only",
							task: "do the work",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							model: "xai/grok-4.5",
							thinking: "high",
							modelSelection: { kind: "tier", tier: "light" },
							progress: {
								index: 0,
								description: "Search auth flow for bugs",
								permissions: "read-only",
								status: "running",
								task: "do the work",
								model: "xai/grok-4.5",
								thinking: "high",
								modelSelection: { kind: "tier", tier: "light" },
								recentTools: [],
								recentOutput: [],
								toolCount: 3,
								tokens: 100,
								durationMs: 1000,
							},
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
		);
		const header = result.render(120)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(header).toContain("Search auth flow for bugs");
		expect(header).toContain("light");
		expect(header).toContain("thinking high");
		expect(header).not.toContain("grok-4.5");
	});

	it("shows the model id when the child was selected by model", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [
						{
							description: "Search auth flow for bugs",
							permissions: "read-only",
							task: "do the work",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							model: "xai/grok-4.5",
							thinking: "high",
							modelSelection: { kind: "model" },
							progress: {
								index: 0,
								description: "Search auth flow for bugs",
								permissions: "read-only",
								status: "running",
								task: "do the work",
								model: "xai/grok-4.5",
								thinking: "high",
								modelSelection: { kind: "model" },
								recentTools: [],
								recentOutput: [],
								toolCount: 3,
								tokens: 100,
								durationMs: 1000,
							},
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
		);
		const header = result.render(120)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(header).toContain("grok-4.5");
		expect(header).not.toContain("light");
	});
});

describe("formatModelSelection", () => {
	it("prints the tier name for a tier selection", () => {
		expect(formatModelSelection({ kind: "tier", tier: "standard" }, "xai/grok-4.5", "high")).toBe(
			"standard · thinking high",
		);
	});

	it("prints the resolved model for explicit model and inherit", () => {
		expect(formatModelSelection({ kind: "model" }, "xai/grok-4.5", "high")).toBe("grok-4.5 · thinking high");
		expect(formatModelSelection({ kind: "inherit" }, "xai/grok-4.5")).toBe("grok-4.5");
		expect(formatModelSelection(undefined, "xai/grok-4.5")).toBe("grok-4.5");
	});
});

describe("renderMultiCompact selection badge", () => {
	const stubTheme = {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
		italic: (value: string) => value,
	};

	it("shows the selected tier on compact parallel rows", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					results: [
						{
							description: "Search auth flow for bugs",
							agent: "Search auth flow for bugs",
							permissions: "read-only",
							task: "do the work",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							model: "xai/grok-4.5",
							thinking: "high",
							modelSelection: { kind: "tier", tier: "light" },
							progress: {
								index: 0,
								agent: "Search auth flow for bugs",
								description: "Search auth flow for bugs",
								permissions: "read-only",
								status: "running",
								task: "do the work",
								model: "xai/grok-4.5",
								thinking: "high",
								modelSelection: { kind: "tier", tier: "light" },
								recentTools: [],
								recentOutput: [],
								toolCount: 3,
								tokens: 100,
								durationMs: 1000,
							},
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
		);
		const lines = result.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(lines.some((line) => line.includes("Search auth flow for bugs") && line.includes("light"))).toBe(true);
		expect(lines.some((line) => line.includes("Search auth flow for bugs") && line.includes("grok-4.5"))).toBe(false);
	});
});
