import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTokenTotal, updateGoalUsage } from "../src/builtin-extensions/narumiruna-pi-goal/src/accounting.ts";
import { parseSessionTokens } from "../src/builtin-extensions/pi-subagents/src/shared/session-tokens.ts";
import { registerSlashCommands } from "../src/builtin-extensions/pi-subagents/src/slash/slash-commands.ts";
import { renderSubagentResult } from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";
import { estimateContextTokens } from "../src/core/compaction/compaction.ts";
import { computeContextBreakdown } from "../src/core/context-breakdown.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { collectUsageRequests, totalRequestUsage } from "../src/core/usage-accounting.ts";
import { collectUsageHistory, resetUsageHistoryCache } from "../src/core/usage-history.ts";
import { renderUsageBox } from "../src/modes/interactive/components/usage-view.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	resetUsageHistoryCache();
});
function usage(input = 100, output = 200, cacheRead = 10000, cacheWrite = 1000) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
function assistant(timestamp = 100): AssistantMessage {
	return {
		...fauxAssistantMessage("answer"),
		api: "openai-responses",
		provider: "openai",
		model: "test",
		timestamp,
		usage: usage(),
	};
}
async function harness() {
	const h = await createHarness();
	harnesses.push(h);
	return h;
}
function temp() {
	const d = mkdtempSync(join(tmpdir(), "review-"));
	dirs.push(d);
	return d;
}

describe("token accounting", () => {
	it("includes cache tokens across all child attempts", () => {
		const d = temp();
		writeFileSync(join(d, "child.jsonl"), JSON.stringify({ type: "message", message: assistant() }));
		expect(parseSessionTokens(d)).toMatchObject({
			input: 11100,
			output: 200,
			total: 11300,
			cacheRead: 10000,
			cacheWrite: 1000,
		});
	});
	it("persists compaction request usage independently of conversation context", async () => {
		const h = await harness();
		h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		h.sessionManager.appendMessage({ role: "user", content: "message to compact", timestamp: Date.now() - 1000 });
		const a = assistant(Date.now() - 500);
		a.usage = usage(100, 0, 0, 0);
		h.sessionManager.appendMessage(a);
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		h.session.agent.streamFn = (model) => {
			const s = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = {
					...assistant(Date.now()),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage(5000, 500, 0, 0),
				};
				s.push({ type: "done", reason: "stop", message });
			});
			return s;
		};
		expect(h.session.getSessionStats().tokens.total).toBe(100);
		await h.session.compact();
		expect(h.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		expect(h.session.getSessionStats().tokens.total).toBe(5600);
	});
	it("estimates the first request system prompt and tool schemas", async () => {
		const h = await harness();
		h.session.agent.state.systemPrompt = "x".repeat(4000);
		expect(h.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1000);
		expect(h.session.getContextUsage()?.estimated).toBe(true);
		const b = computeContextBreakdown({
			systemPrompt: h.session.systemPrompt,
			tools: [],
			messages: [],
			contextWindow: 10000,
		});
		expect(b.total).toBe(1000);
	});
	it("ignores pre-compaction usage after a newer summary", () => {
		const messages = [
			{ role: "compactionSummary" as const, summary: "brief", tokensBefore: 11300, timestamp: 200 },
			assistant(100),
			{ role: "user" as const, content: "tail", timestamp: 300 },
		];
		expect(estimateContextTokens(messages).lastUsageIndex).toBeNull();
		expect(estimateContextTokens(messages).tokens).toBeLessThan(100);
	});
	it("uses full prompt input in usage labels", () => {
		initTheme("moon");
		const out = renderUsageBox(
			{
				sessionTotals: { input: 100, output: 200, cacheRead: 10000, cacheWrite: 1000, total: 11300 },
				context: undefined,
				plan: [],
			},
			200,
		)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("input 11k");
		expect(out).toContain("total 11k");
		expect(out).toContain("cached 10k (90%)");
	});
	it("keeps goal usage after navigating away from incurred requests", async () => {
		const h = await harness();
		const first = h.sessionManager.appendMessage(assistant());
		h.sessionManager.appendMessage(assistant(200));
		const ctx = { sessionManager: h.sessionManager };
		expect(currentTokenTotal(ctx)).toBe(22600);
		const goal = { status: "active", baselineTokens: 0, tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 0 };
		updateGoalUsage(goal, ctx);
		expect(goal.tokensUsed).toBe(22600);
		h.sessionManager.branch(first);
		updateGoalUsage(goal, ctx);
		expect(goal.tokensUsed).toBe(22600);
	});
	it("filters request timestamps in recently modified history files", () => {
		const d = temp();
		const header = { type: "session", version: 3, id: "fixture", timestamp: new Date().toISOString(), cwd: "/tmp" };
		const entry = {
			type: "message",
			id: "a",
			parentId: null,
			timestamp: "2020-01-01T00:00:00.000Z",
			message: assistant(),
		};
		writeFileSync(join(d, "history.jsonl"), [header, entry].map(JSON.stringify).join("\n"));
		const out = collectUsageHistory({ sessionsDir: d, sinceMs: Date.now() - 30 * 86400000 });
		expect(out.perDay).toEqual([]);
	});
	it("excludes shell output that is absent from provider context", () => {
		const b = computeContextBreakdown({
			systemPrompt: "",
			tools: [],
			contextWindow: 10000,
			messages: [
				{
					role: "bashExecution",
					command: "pwd",
					output: "x".repeat(4000),
					excludeFromContext: true,
					timestamp: 100,
					exitCode: 0,
					cancelled: false,
					truncated: false,
				},
			],
		});
		expect(b.toolResults).toBe(0);
	});
});

describe("accounting integration probes", () => {
	it("Codex request preparation ignores stale retained usage", async () => {
		const h = await harness();
		h.session.agent.state.model = { ...h.getModel(), provider: "openai-codex", contextWindow: 10000 };
		h.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 } });
		const messages = [
			{ role: "compactionSummary" as const, summary: "brief", tokensBefore: 11300, timestamp: 200 },
			assistant(100),
			{ role: "user" as const, content: "tail", timestamp: 300 },
		];
		const compact = vi.spyOn(h.session as never, "_runAutoCompaction").mockResolvedValue(false as never);
		await h.session.agent.prepareNextTurnWithContext!({
			context: { systemPrompt: "system", tools: [], messages },
		} as never);
		expect(compact).not.toHaveBeenCalled();
	});
	it("renders complete child counts consistently with cached usage", () => {
		const theme = { fg: (_t: string, v: string) => v, bold: (v: string) => v, italic: (v: string) => v };
		const result = { description: "review", task: "review", exitCode: 0, usage: { ...usage(), cost: 0, turns: 1 } };
		const view = (r: unknown) =>
			renderSubagentResult(
				{ content: [{ type: "text", text: "done" }], details: { mode: "single", results: [r] } } as never,
				{ expanded: false },
				theme as never,
			)
				.render(180)
				.join("\n");
		expect(view({ ...result, progressSummary: { tokens: 300, status: "complete", durationMs: 1000 } })).toContain(
			"11k token",
		);
		expect(view(result)).toContain("11k token");
	});
	it("subagent cost command includes asynchronous completion receipts exactly once", async () => {
		const cmds = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		let output = "";
		registerSlashCommands(
			{
				registerShortcut: () => {},
				registerCommand: (n: string, v: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
					cmds.set(n, v),
				sendMessage: (m: { content: string }) => {
					output = m.content;
				},
			} as never,
			{} as never,
		);
		const entries = [
			{ type: "message", message: assistant() },
			{
				type: "custom_message",
				customType: "subagent-notify",
				content: "Background task completed: **child**\n\ndone\n\nSession file: /tmp/child.jsonl",
				details: {
					children: [
						{
							childId: "child",
							agent: "child",
							usage: { input: 100, output: 200, cacheRead: 10000, cacheWrite: 1000, cost: 0, turns: 1 },
						},
					],
				},
			},
		];
		await cmds.get("subagent-cost")!.handler("", { sessionManager: { getEntries: () => entries } });
		expect(output).toContain("Child 1 (child)");
		expect(output).toContain("Children: ↑11k");
	});
});

describe("durable request accounting", () => {
	it("records failed and cancelled auxiliary requests without injecting them into context", async () => {
		const h = await harness();
		const failed = assistant();
		failed.stopReason = "error";
		failed.usage = usage(1000, 200, 0, 0);
		const cancelled = assistant();
		cancelled.stopReason = "aborted";
		cancelled.usage = { ...usage(500, 0, 100, 0), measurement: "partial" };
		h.sessionManager.appendRequestUsage("compaction", failed);
		h.sessionManager.appendRequestUsage("branch-summary", cancelled);
		expect(h.sessionManager.buildSessionContext().messages).toEqual([]);
		expect(h.session.getSessionStats().tokens.total).toBe(1800);
		expect(h.session.getSessionStats().parentUsage?.partialRequests).toBe(1);
	});
	it("forks inherited context without charging it to the new session", async () => {
		const h = await harness();
		h.sessionManager.appendMessage({ role: "user", content: "keep context", timestamp: Date.now() });
		const leaf = h.sessionManager.appendMessage(assistant());
		h.sessionManager.createBranchedSession(leaf);
		expect(h.sessionManager.buildSessionContext().messages.length).toBe(2);
		expect(h.session.getSessionStats().tokens.total).toBe(0);
		h.sessionManager.appendMessage(assistant(200));
		expect(h.session.getSessionStats().tokens.total).toBe(11300);
	});
	it("deduplicates cumulative child receipts and includes them in goal and combined usage", async () => {
		const h = await harness();
		h.sessionManager.appendMessage(assistant());
		const child = {
			childId: "child",
			agent: "review",
			usage: { input: 100, output: 200, cacheRead: 10000, cacheWrite: 1000, cost: 2, turns: 1 },
		};
		for (const receipt of [child, { ...child, usage: { ...child.usage, output: 300 } }, child]) {
			h.sessionManager.appendCustomMessageEntry("subagent-notify", "done", true, { children: [receipt] });
		}
		expect(h.session.getSessionStats().childUsage?.total).toBe(11400);
		expect(h.session.getSessionStats().combinedUsage?.total).toBe(22700);
		expect(currentTokenTotal({ sessionManager: h.sessionManager })).toBe(22700);
	});
	it("scans earlier failed attempts and removes duplicate inherited requests", () => {
		const d = temp();
		const request = assistant();
		request.usage.requestId = "request-1";
		const first = { type: "message", id: "a", timestamp: new Date().toISOString(), parentId: null, message: request };
		const secondRequest = assistant();
		secondRequest.usage.requestId = "request-2";
		writeFileSync(join(d, "attempt-one.jsonl"), JSON.stringify(first));
		writeFileSync(
			join(d, "attempt-two.jsonl"),
			[first, { ...first, id: "b", message: secondRequest }].map(JSON.stringify).join("\n"),
		);
		expect(parseSessionTokens(d)?.total).toBe(22600);
	});
	it("deduplicates request identity across history files while caching parsed records", () => {
		const d = temp();
		const timestamp = new Date().toISOString();
		const request = assistant();
		request.usage.requestId = "shared-request";
		const header = { type: "session", version: 3, id: "session", timestamp, cwd: d };
		const entry = { type: "message", id: "a", parentId: null, timestamp, message: request };
		for (const name of ["original", "fork"])
			writeFileSync(join(d, `${name}.jsonl`), [header, entry].map(JSON.stringify).join("\n"));
		expect(collectUsageHistory({ sessionsDir: d, sinceMs: 0 }).perModel[0]?.total).toBe(11300);
		const narrow = collectUsageHistory({ sessionsDir: d, sinceMs: Date.now() + 1000 });
		expect(narrow.perModel).toEqual([]);
	});
	it("shows missing usage separately from reported zero", async () => {
		const h = await harness();
		const unknown = assistant();
		unknown.usage = { ...usage(0, 0, 0, 0), measurement: "unknown" };
		h.sessionManager.appendRequestUsage("title", unknown);
		const reported = assistant();
		reported.usage = { ...usage(0, 0, 0, 0), measurement: "reported" };
		h.sessionManager.appendMessage(reported);
		expect(h.session.getSessionStats().parentUsage?.unknownRequests).toBe(1);
		initTheme("moon");
		const box = renderUsageBox(
			{ sessionTotals: { input: 0, output: 0, total: 0, unknownRequests: 1 }, context: undefined, plan: [] },
			180,
		).join("\n");
		expect(box).toContain("Usage unavailable for 1 request(s).");
	});
	it("keeps an in-flight title request attributed to its original session", async () => {
		const h = await harness();
		const dir = temp();
		const manager = SessionManager.create(dir, dir);
		const old = assistant(Date.now());
		old.usage = usage(0, 0, 0, 0);
		manager.appendMessage(old);
		const originalFile = manager.getSessionFile()!;
		let settle!: (message: AssistantMessage) => void;
		const complete = vi.fn(
			() =>
				new Promise<AssistantMessage>((resolve) => {
					settle = resolve;
				}),
		);
		const setSessionName = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as { generateSessionTitle(text: string): Promise<void> };
		Reflect.set(mode, "runtimeHost", {
			session: {
				model: h.models[0],
				sessionManager: manager,
				settingsManager: { getModelTiersEnabled: () => false },
				modelRuntime: { complete },
				setSessionName,
			},
		});
		try {
			const pending = mode.generateSessionTitle("review tokens");
			expect(complete).toHaveBeenCalledTimes(1);
			manager.newSession();
			const response = assistant(Date.now());
			response.usage = usage(100, 10, 0, 0);
			settle(response);
			await pending;
			expect(setSessionName).not.toHaveBeenCalled();
			expect(collectUsageRequests(manager.getEntries())).toEqual([]);
			const original = SessionManager.openReadOnly(originalFile);
			try {
				expect(totalRequestUsage(collectUsageRequests(original.getEntries())).total).toBe(110);
			} finally {
				original.dispose();
			}
		} finally {
			manager.dispose();
		}
	});
	it("displays measured zero without calling it missing usage", async () => {
		const h = await harness();
		const zero = assistant(Date.now());
		zero.usage = { ...usage(0, 0, 0, 0), measurement: "reported" };
		h.sessionManager.appendMessage(zero);
		const stats = h.session.getSessionStats();
		expect(stats.parentUsage?.requests).toBe(1);
		initTheme("moon");
		const lines = renderUsageBox({ sessionTotals: stats.parentUsage, context: undefined, plan: [] }, 180).join("\n");
		expect(lines).toContain("Parent usage");
		expect(lines).not.toContain("No usage data yet");
		expect(lines).not.toContain("Usage unavailable");
	});
	it("uses the same non-ASCII prompt estimate in the footer and context breakdown", async () => {
		const h = await harness();
		h.session.agent.state.systemPrompt = "漢".repeat(4000);
		h.session.agent.state.tools = [];
		const context = h.session.getContextUsage();
		const breakdown = computeContextBreakdown({
			systemPrompt: h.session.systemPrompt,
			tools: [],
			messages: [],
			contextWindow: 10000,
		});
		expect(context?.tokens).toBe(4000);
		expect(breakdown.total).toBe(context?.tokens);
	});
});
