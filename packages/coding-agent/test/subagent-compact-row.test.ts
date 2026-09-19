import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	renderSubagentCall,
	renderSubagentNotify,
	resolveSubagentActionDisplayTitle,
} from "../src/builtin-extensions/pi-subagents/src/extension/index.ts";
import { formatAsyncRunList } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-status.ts";
import {
	formatCompactModelBadge,
	formatModelSelection,
} from "../src/builtin-extensions/pi-subagents/src/shared/formatters.ts";
import { SubagentFleetComponent } from "../src/builtin-extensions/pi-subagents/src/tui/fleet.ts";
import {
	buildWidgetLines,
	clearWidgetPaintTimer,
	compactRowLead,
	createSubagentWidgetComponent,
	formatCompactSubagentRow,
	renderSubagentResult,
	renderWidget,
	stripTaskChrome,
	subagentAnimSink,
} from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";

afterEach(() => {
	subagentAnimSink.current = null;
	clearWidgetPaintTimer();
	vi.useRealTimers();
});

const stubTheme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
	italic: (value: string) => value,
};

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

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

describe("formatCompactSubagentRow", () => {
	it("prints description, model badge, tokens, and time on one line", () => {
		expect(
			formatCompactSubagentRow(stubTheme as never, 80, {
				glyph: "⠋",
				description: "Search auth flow for bugs",
				modelBadge: "standard",
				tokens: 94_000,
				durationMs: 3 * 60_000 + 37_000,
			}),
		).toBe("⠋ Search auth flow for bugs · standard · 94k token · 3m37s");
	});

	it("omits the model badge when empty and still shows tokens and time", () => {
		expect(
			formatCompactSubagentRow(stubTheme as never, 80, {
				glyph: "✓",
				description: "Check timer",
				tokens: 0,
				durationMs: 0,
			}),
		).toBe("✓ Check timer · 0 token · 0ms");
	});

	it("truncates to terminal width without wrapping", () => {
		const line = formatCompactSubagentRow(stubTheme as never, 20, {
			glyph: "●",
			description: "Search auth flow for bugs",
			modelBadge: "standard",
			tokens: 999_999,
			durationMs: 12_000,
		});
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("async widget, fleet, and status timing", () => {
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
		expect(buildWidgetLines([job] as never, stubTheme as never, 120).join("\n")).toContain("2s");
		vi.advanceTimersByTime(1_000);
		expect(buildWidgetLines([job] as never, stubTheme as never, 120).join("\n")).toContain("3s");

		job.status = "complete";
		job.updatedAt = 12_000;
		const terminal = buildWidgetLines([job] as never, stubTheme as never, 120).join("\n");
		vi.advanceTimersByTime(5_000);
		expect(terminal).toContain("2s");
		expect(terminal).not.toContain("3s");
		expect(buildWidgetLines([job] as never, stubTheme as never, 120).join("\n")).toBe(terminal);
	});

	it("matches compact foreground rows for a single async child", () => {
		const job = {
			asyncId: "review-run",
			asyncDir: "Z:/missing/review-run",
			status: "running",
			mode: "single",
			agents: ["Review startup lifecycle"],
			toolCount: 46,
			totalTokens: { total: 78_000 },
			startedAt: 0,
			updatedAt: 0,
			steps: [
				{
					agent: "Review startup lifecycle",
					description: "Review startup lifecycle risks",
					status: "running",
					modelSelection: { kind: "tier", tier: "standard" },
					thinking: "high",
					permissions: "read-only",
					toolCount: 46,
					tokens: { total: 78_000 },
					startedAt: 0,
				},
			],
		};
		const rendered = buildWidgetLines([job] as never, stubTheme as never, 120).join("\n");
		expect(rendered).toContain("Review startup lifecycle risks");
		expect(rendered).toContain("standard");
		expect(rendered).toContain("78k token");
		expect(rendered).not.toContain("46 tool uses");
		expect(rendered).not.toContain("thinking high");
		expect(rendered).not.toContain("read-only");
		expect(rendered).not.toContain("⎿");
		expect(rendered).not.toContain("async subagent");
		expect(rendered).not.toContain("Step 1/1");
		expect(rendered).not.toContain("Press");
	});

	it("renders mixed async jobs as flat compact rows without an aggregate tree", () => {
		const jobs = [
			{
				asyncId: "one",
				asyncDir: "Z:/missing/one",
				status: "running",
				mode: "single",
				agents: ["First child"],
				steps: [
					{
						agent: "First child",
						description: "First child",
						status: "running",
						startedAt: 0,
						tokens: { total: 1000 },
					},
				],
				startedAt: 0,
				updatedAt: 0,
			},
			{
				asyncId: "two",
				asyncDir: "Z:/missing/two",
				status: "complete",
				mode: "single",
				agents: ["Second child"],
				steps: [
					{
						agent: "Second child",
						description: "Second child",
						status: "complete",
						startedAt: 0,
						endedAt: 2000,
						tokens: { total: 2000 },
					},
				],
				startedAt: 0,
				updatedAt: 2000,
			},
		];
		const rendered = buildWidgetLines(jobs as never, stubTheme as never, 120).join("\n");
		const lines = rendered.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("First child");
		expect(lines[1]).toContain("Second child");
		expect(rendered).not.toContain("Async agents");
		expect(rendered).not.toContain("background");
		expect(rendered).not.toContain("├─");
		expect(rendered).not.toContain("└─");
		expect(rendered).not.toContain("⎿");
	});

	it("shows every chain and parallel child as a flat row, not only steps[0]", () => {
		const jobs = [
			{
				asyncId: "chain-run",
				asyncDir: "Z:/missing/chain-run",
				status: "running",
				mode: "chain",
				agents: ["Done step", "Live step"],
				steps: [
					{
						agent: "Done step",
						description: "Finished chain step",
						status: "complete",
						startedAt: 0,
						endedAt: 1000,
						tokens: { total: 1000 },
					},
					{
						agent: "Live step",
						description: "Running chain step",
						status: "running",
						startedAt: 1000,
						tokens: { total: 500 },
					},
				],
				startedAt: 0,
				updatedAt: 1000,
			},
			{
				asyncId: "parallel-run",
				asyncDir: "Z:/missing/parallel-run",
				status: "running",
				mode: "parallel",
				agents: ["Sibling A", "Sibling B"],
				steps: [
					{
						agent: "Sibling A",
						description: "Parallel sibling A",
						status: "running",
						startedAt: 0,
						tokens: { total: 200 },
					},
					{
						agent: "Sibling B",
						description: "Parallel sibling B",
						status: "running",
						startedAt: 0,
						tokens: { total: 300 },
					},
				],
				startedAt: 0,
				updatedAt: 0,
			},
		];
		const rendered = buildWidgetLines(jobs as never, stubTheme as never, 160).join("\n");
		expect(rendered).toContain("Finished chain step");
		expect(rendered).toContain("Running chain step");
		expect(rendered).toContain("Parallel sibling A");
		expect(rendered).toContain("Parallel sibling B");
	});

	it("keeps failed and stopped children to one clear row, with diagnostics only when expanded", () => {
		const jobs = [
			{
				asyncId: "mixed-run",
				asyncDir: "Z:/missing/mixed-run",
				status: "failed",
				mode: "parallel",
				agents: ["Live", "Failed", "Stopped"],
				steps: [
					{ agent: "Live", description: "Live child", status: "running", tokens: { total: 10 } },
					{
						agent: "Failed",
						description: "Failed child",
						status: "failed",
						error: "child crashed",
						tokens: { total: 20 },
					},
					{ agent: "Stopped", description: "Stopped child", status: "stopped", tokens: { total: 30 } },
				],
			},
		];
		const collapsed = buildWidgetLines(jobs as never, stubTheme as never, 48, false, 0);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[1]).toContain("Failed child");
		expect(collapsed[1]).toContain("failed");
		expect(collapsed[2]).toContain("Stopped child");
		expect(collapsed[2]).toContain("stopped");
		expect(collapsed.join("\n")).not.toContain("Agent 1");
		expect(collapsed.join("\n")).not.toContain("child crashed");
		for (const line of collapsed) expect(visibleWidth(line)).toBeLessThanOrEqual(48);

		const expanded = buildWidgetLines(jobs as never, stubTheme as never, 80, true, 0).join("\n");
		expect(expanded).toContain("run mixed-run:1 · failed");
		expect(expanded).toContain("child crashed");
		expect(expanded.match(/Failed child/g)).toHaveLength(1);
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
			stubTheme as never,
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

describe("widget component timer", () => {
	it("advances the glyph on the 80ms component timer without setWidget rebuilds", () => {
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
			totalTokens: { total: 1000 },
			steps: [
				{
					agent: "Check timer",
					description: "Check timer",
					status: "running",
					startedAt: 10_000,
					tokens: { total: 1000 },
				},
			],
		};
		let paints = 0;
		const widget = createSubagentWidgetComponent([job] as never, stubTheme as never, {
			requestRender: () => {
				paints += 1;
			},
		});
		try {
			const first = stripAnsi(widget.render(120).join("\n"));
			expect(first).toContain("Check timer");
			expect(first).toContain("2s");
			vi.advanceTimersByTime(80);
			expect(paints).toBeGreaterThan(0);
			const second = stripAnsi(widget.render(120).join("\n"));
			expect(second).not.toBe(first);
			vi.advanceTimersByTime(920);
			expect(stripAnsi(widget.render(120).join("\n"))).toContain("3s");
		} finally {
			widget.dispose();
		}
	});

	it("keeps widget identity when jobs reorder and does not call setWidget again", () => {
		const jobA = {
			asyncId: "a",
			asyncDir: "Z:/missing/a",
			status: "running",
			mode: "single",
			agents: ["A"],
			startedAt: 0,
			updatedAt: 0,
			steps: [{ agent: "A", description: "A", status: "running", startedAt: 0 }],
		};
		const jobB = {
			asyncId: "b",
			asyncDir: "Z:/missing/b",
			status: "queued",
			mode: "single",
			agents: ["B"],
			startedAt: 0,
			updatedAt: 0,
			steps: [{ agent: "B", description: "B", status: "queued", startedAt: 0 }],
		};
		let setWidgetCalls = 0;
		let mounted: { dispose?: () => void } | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: ((tui: unknown, theme: unknown) => { dispose?: () => void }) | undefined) {
					setWidgetCalls += 1;
					if (!factory) {
						mounted?.dispose?.();
						mounted = undefined;
						return;
					}
					mounted = factory(null, stubTheme);
				},
				requestRender() {},
				getToolsExpanded() {
					return false;
				},
			},
		};
		try {
			renderWidget(ctx as never, [jobA, jobB] as never);
			expect(setWidgetCalls).toBe(1);
			const first = mounted;
			renderWidget(ctx as never, [jobB, jobA] as never);
			expect(setWidgetCalls).toBe(1);
			expect(mounted).toBe(first);
		} finally {
			renderWidget(ctx as never, []);
		}
	});
});

describe("renderSingleCompact thinking line", () => {
	it("registers live clock lines and terminal rows freeze duration", () => {
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
		expect(subagentAnimSink.current).toHaveLength(1);
		const initialGlyph = live.render(120).join("\n").trim().split(" ")[0];
		vi.advanceTimersByTime(80);
		for (const entry of subagentAnimSink.current ?? []) entry.text.setText(entry.line(1, Date.now()));
		expect(live.render(120).join("\n").trim().split(" ")[0]).not.toBe(initialGlyph);
		const secondGlyph = live.render(120).join("\n").trim().split(" ")[0];
		vi.advanceTimersByTime(920);
		for (const entry of subagentAnimSink.current ?? []) entry.text.setText(entry.line(12, Date.now()));
		expect(live.render(120).join("\n").trim().split(" ")[0]).not.toBe(secondGlyph);
		expect(live.render(120).join("\n")).toContain("3s");
		expect(live.render(120).join("\n")).not.toContain("tool use");

		subagentAnimSink.current = [];
		const terminal = renderSubagentResult(makeResult("completed") as never, { expanded: false }, stubTheme, 0);
		const first = terminal.render(120).join("\n");
		vi.advanceTimersByTime(5_000);
		const later = terminal.render(120).join("\n");
		expect(first).toContain("2s");
		expect(first).not.toContain("ran for");
		expect(later).toBe(first);
		expect(subagentAnimSink.current).toHaveLength(0);
	});

	it("shows description-first compact row without hang, thinking, or permission", () => {
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
		const lines = result.render(120).map((line) => stripAnsi(line));
		expect(lines[0]).toContain("Search auth flow for bugs");
		expect(lines[0]).toContain("grok-4.5");
		expect(lines[0]).toContain("172k token");
		expect(lines[0]).toContain("9m56s");
		expect(lines[0]).not.toContain("worker");
		expect(lines[0]).not.toContain("scout");
		expect(lines[0]).not.toContain("thinking high");
		expect(lines[0]).not.toContain("read-only");
		expect(lines[0]).not.toContain("tool use");
		expect(lines.some((line) => line.includes("Considering the next read of src/foo.ts"))).toBe(false);
		expect(lines.some((line) => /needs attention/i.test(line))).toBe(false);
		expect(lines.some((line) => /read:/.test(line))).toBe(false);
		expect(lines.some((line) => line.includes("⎿"))).toBe(false);
		expect(lines).toHaveLength(1);
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
		const header = stripAnsi(result.render(120)[0]!);
		expect(header).toContain("Search auth flow for bugs");
		expect(header).toContain("light");
		expect(header).not.toContain("thinking high");
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
		const header = stripAnsi(result.render(120)[0]!);
		expect(header).toContain("grok-4.5");
		expect(header).not.toContain("light");
		expect(header).not.toContain("thinking high");
	});
});

describe("formatModelSelection", () => {
	it("prints the tier name for a tier selection", () => {
		expect(formatModelSelection({ kind: "tier", tier: "standard" }, "xai/grok-4.5", "high")).toBe(
			"standard · thinking high",
		);
	});

	it("prints the resolved model for explicit model and inherit", () => {
		expect(formatModelSelection({ kind: "model" } as never, "xai/grok-4.5", "high")).toBe("grok-4.5 · thinking high");
		expect(formatModelSelection({ kind: "inherit" } as never, "xai/grok-4.5")).toBe("grok-4.5");
		expect(formatModelSelection(undefined, "xai/grok-4.5")).toBe("grok-4.5");
	});
});

describe("formatCompactModelBadge", () => {
	it("prints the tier, explicit model, or resolved inherit model without thinking", () => {
		expect(formatCompactModelBadge({ kind: "tier", tier: "standard" }, "xai/grok-4.5")).toBe("standard");
		expect(formatCompactModelBadge({ kind: "model" }, "xai/grok-4.5")).toBe("grok-4.5");
		expect(formatCompactModelBadge({ kind: "model", model: "anthropic/claude-opus-4" }, "xai/grok-4.5")).toBe(
			"claude-opus-4",
		);
		expect(formatCompactModelBadge({ kind: "inherit" }, "xai/grok-4.5")).toBe("grok-4.5");
		expect(formatCompactModelBadge(undefined, "xai/grok-4.5")).toBe("grok-4.5");
	});

	it("strips a :high thinking suffix from explicit and resolved-only models", () => {
		expect(formatCompactModelBadge({ kind: "model", model: "xai/grok-4.5:high" }, "unused/model:low")).toBe(
			"grok-4.5",
		);
		expect(formatCompactModelBadge({ kind: "model" }, "xai/grok-4.5:high")).toBe("grok-4.5");
		expect(formatCompactModelBadge({ kind: "inherit" }, "xai/grok-4.5:high")).toBe("grok-4.5");
		expect(formatCompactModelBadge(undefined, "xai/grok-4.5:high")).toBe("grok-4.5");
		expect(formatCompactModelBadge({ kind: "model" }, "xai/grok-4.5:high")).not.toContain("thinking");
	});
});

describe("renderMultiCompact selection badge", () => {
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
		const lines = result.render(120).map((line) => stripAnsi(line));
		expect(lines.some((line) => line.includes("Search auth flow for bugs") && line.includes("light"))).toBe(true);
		expect(lines.some((line) => line.includes("Search auth flow for bugs") && line.includes("grok-4.5"))).toBe(false);
		expect(lines.some((line) => line.includes("thinking high"))).toBe(false);
		expect(lines.some((line) => line.includes("tool use"))).toBe(false);
	});

	it("renders mixed foreground children as flat rows with terminal state inline", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "mixed" }],
				details: {
					mode: "parallel",
					results: [
						{
							description: "Completed child",
							task: "complete",
							exitCode: 0,
							usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
							progressSummary: { status: "completed", tokens: 20, durationMs: 1000 },
						},
						{
							description: "Running child",
							task: "run",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							progress: { index: 1, status: "running", tokens: 30, durationMs: 2000 },
						},
						{
							description: "Failed child",
							task: "fail",
							exitCode: 1,
							error: "private diagnostic",
							usage: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
							progressSummary: { status: "failed", tokens: 40, durationMs: 3000 },
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
			0,
		);
		const lines = result.render(120).map((line) => stripAnsi(line));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("Completed child");
		expect(lines[1]).toContain("Running child");
		expect(lines[2]).toContain("Failed child");
		expect(lines[2]).toContain("failed");
		expect(lines.join("\n")).not.toContain("parallel");
		expect(lines.join("\n")).not.toContain("private diagnostic");
	});

	it("maps mixed chain fanout rows by workflow flat index and preserves workflow-only status", () => {
		const details = {
			mode: "chain",
			results: [
				{
					agent: "source-child",
					description: "Collect source items",
					task: "collect",
					exitCode: 0,
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					progressSummary: { index: 0, status: "completed", toolCount: 0, tokens: 20, durationMs: 1000 },
				},
			],
			progress: [
				{
					index: 1,
					description: "Review alpha",
					status: "running",
					toolCount: 0,
					tokens: 30,
					durationMs: 2000,
				},
			],
			totalSteps: 3,
			currentStepIndex: 1,
			workflowGraph: {
				runId: "dynamic-chain",
				mode: "chain",
				phases: [],
				nodes: [
					{
						id: "step-0",
						kind: "step",
						label: "Collect source items",
						status: "completed",
						flatIndex: 0,
						stepIndex: 0,
					},
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review collected items",
						status: "running",
						stepIndex: 1,
						children: [
							{
								id: "alpha",
								kind: "agent",
								label: "Review alpha",
								status: "running",
								flatIndex: 1,
								stepIndex: 1,
							},
							{
								id: "beta",
								kind: "agent",
								label: "Review beta",
								status: "failed",
								flatIndex: 2,
								stepIndex: 1,
								error: "beta failed",
							},
						],
					},
					{
						id: "step-2",
						kind: "step",
						label: "Summarize reviews",
						status: "pending",
						flatIndex: 3,
						stepIndex: 2,
					},
				],
			},
		};

		const collapsed = renderSubagentResult(
			{ content: [{ type: "text", text: "running" }], details } as never,
			{ expanded: false },
			stubTheme,
			0,
		)
			.render(140)
			.map((line) => stripAnsi(line));
		expect(collapsed).toHaveLength(4);
		expect(collapsed[0]).toContain("Collect source items");
		expect(collapsed[1]).toContain("Review alpha");
		expect(collapsed[2]).toContain("Review beta");
		expect(collapsed[2]).toContain("failed");
		expect(collapsed[3]).toContain("Summarize reviews");
		expect(collapsed[3]?.trim().startsWith("◦")).toBe(true);
		expect(collapsed.join("\n")).not.toContain("Review collected items");
		expect(collapsed.join("\n")).not.toContain("beta failed");

		const expanded = stripAnsi(
			renderSubagentResult(
				{
					content: [{ type: "text", text: "running" }],
					details: { ...details, currentStepIndex: undefined, progress: [] },
				} as never,
				{ expanded: true },
				stubTheme,
				0,
			)
				.render(140)
				.join("\n"),
		);
		expect(expanded).toContain("Review beta");
		expect(expanded).toContain("status: failed");
		expect(expanded).toContain("error: beta failed");
		expect(expanded).toContain("Summarize reviews");
		expect(expanded).toContain("status: pending");
	});

	it("uses persisted flat indexes when dynamic results arrive out of array order", () => {
		const childResult = (index: number, description: string) => ({
			agent: description,
			description,
			task: description,
			exitCode: 0,
			usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			progressSummary: { index, status: "completed", toolCount: 0, tokens: 10, durationMs: 1000 },
		});
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "chain",
					results: [childResult(1, "Second dynamic child"), childResult(0, "First dynamic child")],
					workflowGraph: {
						runId: "reordered-dynamic",
						mode: "chain",
						phases: [],
						nodes: [
							{
								id: "step-0",
								kind: "dynamic-parallel-group",
								label: "Dynamic group",
								status: "completed",
								stepIndex: 0,
								children: [
									{
										id: "first",
										kind: "agent",
										label: "First",
										status: "completed",
										flatIndex: 0,
										stepIndex: 0,
									},
									{
										id: "second",
										kind: "agent",
										label: "Second",
										status: "completed",
										flatIndex: 1,
										stepIndex: 0,
									},
								],
							},
						],
					},
				},
			} as never,
			{ expanded: false },
			stubTheme,
		)
			.render(120)
			.map((line) => stripAnsi(line));
		expect(result[0]).toContain("First dynamic child");
		expect(result[1]).toContain("Second dynamic child");
	});

	it("renders a failed unmaterialized dynamic group without result entries", () => {
		const details = {
			mode: "chain",
			results: [],
			totalSteps: 1,
			workflowGraph: {
				runId: "empty-dynamic-chain",
				mode: "chain",
				phases: [],
				nodes: [
					{
						id: "step-0",
						kind: "dynamic-parallel-group",
						label: "Expand review targets",
						status: "failed",
						stepIndex: 0,
						error: "source output was invalid",
						children: [],
					},
				],
			},
		};
		const collapsed = stripAnsi(
			renderSubagentResult(
				{ content: [{ type: "text", text: "fallback result text" }], details } as never,
				{ expanded: false },
				stubTheme,
			)
				.render(120)
				.join("\n"),
		);
		expect(collapsed).toContain("Expand review targets");
		expect(collapsed).toContain("failed");
		expect(collapsed).not.toContain("fallback result text");
		expect(collapsed).not.toContain("source output was invalid");
	});
});

describe("management control results", () => {
	it("uses usage totals when a completed child has no progressSummary tokens", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					results: [
						{
							description: "Inspect auth flow",
							task: "inspect",
							exitCode: 0,
							usage: { input: 600, output: 600, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						},
					],
				},
			} as never,
			{ expanded: false },
			stubTheme,
		);
		expect(stripAnsi(result.render(120).join("\n"))).toContain("1.2k token");
	});

	it("renders subagent stop with empty results as text, not compact child rows", () => {
		const result = renderSubagentResult(
			{
				content: [{ type: "text", text: "Stopped 1 running child." }],
				details: { mode: "management", results: [] },
			} as never,
			{ expanded: false },
			stubTheme,
		);
		const text = stripAnsi(result.render(120).join("\n"));
		expect(text).toContain("Stopped 1 running child.");
		expect(text).not.toContain("token");
		expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		expect(text).not.toContain("⎿");
	});
});

describe("subagent steering call headers", () => {
	const state = {
		asyncJobs: new Map([
			[
				"parallel-123",
				{
					asyncId: "parallel-123",
					asyncDir: "Z:/missing/parallel-123",
					status: "running",
					mode: "parallel",
					steps: [
						{ index: 0, agent: "internal-a", description: "Inspect runtime and native tools", status: "running" },
						{ index: 1, agent: "internal-b", description: "Review tests", status: "running" },
					],
				},
			],
			[
				"chain-456",
				{
					asyncId: "chain-456",
					asyncDir: "Z:/missing/chain-456",
					status: "running",
					mode: "chain",
					steps: [
						{ index: 0, agent: "internal-c", description: "Collect evidence", status: "complete" },
						{ index: 1, agent: "internal-d", description: "Write focused fix", status: "running" },
					],
				},
			],
		]),
		fleetJobs: new Map(),
	} as never;

	it("resolves indexed children and labels a whole multi-child run honestly", () => {
		expect(resolveSubagentActionDisplayTitle({ id: "parallel", index: 0 }, state)).toBe(
			"Inspect runtime and native tools",
		);
		expect(resolveSubagentActionDisplayTitle({ id: "parallel-123" }, state)).toBe("parallel run");
		expect(resolveSubagentActionDisplayTitle({ id: "chain-456", index: 1 }, state)).toBe("Write focused fix");
		expect(resolveSubagentActionDisplayTitle({ id: "chain-456" }, state)).toBe("chain run");
	});

	it("uses the resolved child title live and preserves result metadata for history", () => {
		const live = stripAnsi(
			renderSubagentCall(
				{ action: "steer", id: "parallel-123", index: 0 },
				stubTheme,
				{},
				{ resolveActionTitle: (args: unknown) => resolveSubagentActionDisplayTitle(args, state) },
			)
				.render(120)
				.join("\n"),
		).trimEnd();
		expect(live).toBe("subagent steer Inspect runtime and native tools");
		expect(live).not.toContain("parallel-123");

		const history = stripAnsi(
			renderSubagentCall({ action: "steer", id: "parallel-123", index: 0 }, stubTheme, {
				result: { details: { displayTitle: "Inspect runtime and native tools" } },
			})
				.render(120)
				.join("\n"),
		).trimEnd();
		expect(history).toBe("subagent steer Inspect runtime and native tools");
	});

	it("falls back to the id only when no title can be resolved", () => {
		const rendered = stripAnsi(
			renderSubagentCall(
				{ action: "steer", id: "missing-run" },
				stubTheme,
				{},
				{ resolveActionTitle: (args: unknown) => resolveSubagentActionDisplayTitle(args, state) },
			)
				.render(120)
				.join("\n"),
		).trimEnd();
		expect(rendered).toBe("subagent steer missing-run");
	});
});

describe("subagent call headers", () => {
	it("labels async launches as subagent async, including chain and parallel", () => {
		expect(
			stripAnsi(
				renderSubagentCall({ async: true, description: "Inspect auth" }, stubTheme, {}).render(80).join("\n"),
			),
		).toContain("subagent async");
		expect(
			stripAnsi(
				renderSubagentCall({ async: true, chain: [{}, {}] }, stubTheme, {})
					.render(80)
					.join("\n"),
			),
		).toContain("subagent async chain (2)");
		expect(
			stripAnsi(
				renderSubagentCall({ async: true, tasks: [{}, {}] }, stubTheme, {})
					.render(80)
					.join("\n"),
			),
		).toContain("subagent async parallel (2)");
	});

	it("defaults omitted async to background and honors explicit foreground", () => {
		expect(
			stripAnsi(renderSubagentCall({ description: "Inspect auth" }, stubTheme, {}).render(80).join("\n")),
		).toContain("subagent async");
		expect(
			stripAnsi(
				renderSubagentCall({ async: false, description: "Inspect auth" }, stubTheme, {}).render(80).join("\n"),
			),
		).not.toContain("async");
	});
});

describe("subagent notify renderer", () => {
	it("prints title and status only", () => {
		const rendered = stripAnsi(
			renderSubagentNotify(
				{
					agent: "Review startup lifecycle",
					status: "completed",
					taskInfo: " (1/2)",
					resultPreview: "line one\nline two",
					durationMs: 4000,
					sessionLabel: "Session",
					sessionValue: "/tmp/session.jsonl",
				},
				stubTheme,
			)
				.render(80)
				.join("\n"),
		);
		expect(rendered).toContain("Review startup lifecycle");
		expect(rendered).toContain("completed");
		expect(rendered).not.toContain("(1/2)");
		expect(rendered).not.toContain("line one");
		expect(rendered).not.toContain("full notification");
		expect(rendered).not.toContain("session.jsonl");
		expect(rendered).not.toContain("⎿");
	});

	it("uses fallback coloring for paused and unknown statuses", () => {
		expect(
			stripAnsi(
				renderSubagentNotify({ agent: "Child", status: "paused", resultPreview: "x" }, stubTheme)
					.render(80)
					.join("\n"),
			),
		).toContain("paused");
		expect(
			stripAnsi(
				renderSubagentNotify({ agent: "Child", status: "stopped", resultPreview: "x" } as never, stubTheme)
					.render(80)
					.join("\n"),
			),
		).toContain("stopped");
	});
});
