import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import intercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";
import { handleSubagentControlNotice } from "../src/builtin-extensions/pi-subagents/src/extension/control-notices.ts";
import { deliverSubagentIntercomMessageEvent } from "../src/builtin-extensions/pi-subagents/src/intercom/result-intercom.ts";
import { createAsyncJobTracker } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-job-tracker.ts";
import registerSubagentNotify from "../src/builtin-extensions/pi-subagents/src/runs/background/notify.ts";
import { createResultWatcher } from "../src/builtin-extensions/pi-subagents/src/runs/background/result-watcher.ts";
import type { SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

vi.mock("../src/builtin-extensions/pi-intercom/config.ts", () => ({
	loadConfig: () => ({ enabled: true, inboundTrigger: "always" }),
	getAskTimeoutMs: () => 60_000,
}));
vi.mock("../src/builtin-extensions/pi-intercom/broker/spawn.ts", () => ({
	isNativeSupervisorChannelActive: () => false,
	spawnBrokerIfNeeded: () => new Promise(() => {}),
}));

afterEach(() => {
	vi.useRealTimers();
});

it.each([false, true])(
	"delivers one owner terminal result through watcher, control and relay, file-backed=%s",
	async (fileBacked) => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "lunr-owner-delivery-"));
		const sessionId = fileBacked ? join(root, "parent.jsonl") : "parent";
		const runId = root.split(/[\\/]/).at(-1)!;
		const asyncDir = join(root, runId);
		const resultsDir = join(root, "results");
		mkdirSync(asyncDir);
		mkdirSync(resultsDir);
		const file = join(resultsDir, `${runId}.json`);
		const result = {
			id: runId,
			agent: "Inspect lock",
			sessionId,
			state: "failed",
			success: false,
			summary: "Research report: add a lock later.",
			nestedChildren: [],
			intercomTarget: "parent",
			results: [
				{
					agent: "Inspect lock",
					success: false,
					output: "Research report: add a lock later.",
					error: "Completion guard rejected missing edits.",
				},
			],
		};
		writeFileSync(file, JSON.stringify(result));
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				runId,
				sessionId,
				state: "failed",
				mode: "single",
				startedAt: Date.now(),
				steps: [{ agent: "Inspect lock", status: "failed" }],
				nestedChildren: [],
			}),
		);
		writeFileSync(
			join(asyncDir, "events.jsonl"),
			`${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				event: {
					type: "needs_attention",
					reason: "completion_guard",
					runId,
					agent: "Inspect lock",
					index: 0,
					ts: Date.now(),
				},
				intercom: { to: "parent", message: "Completion guard rejected missing edits." },
			})}\n`,
		);
		const emitter = new EventEmitter();
		let firstAck = true;
		const events = {
			on(name: string, fn: (data: unknown) => void) {
				emitter.on(name, fn);
				return () => {
					emitter.off(name, fn);
				};
			},
			emit(name: string, data: unknown) {
				if (name === "subagent:result-intercom-delivery" && firstAck) {
					firstAck = false;
					setTimeout(() => emitter.emit(name, data), 750);
				} else emitter.emit(name, data);
			},
		};
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const sendMessage = vi.fn();
		const pi = {
			events,
			sendMessage,
			appendEntry: vi.fn(),
			getSessionName: () => "parent",
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerShortcut: vi.fn(),
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
			},
		};
		const state = {
			currentSessionId: sessionId,
			completionSeen: new Map(),
			asyncJobs: new Map(),
			cleanupTimers: new Map(),
		} as unknown as SubagentState;
		intercomExtension(pi as never);
		await handlers.get("session_start")!(
			{},
			{
				cwd: root,
				model: { id: "test" },
				sessionManager: {
					getSessionId: () => "parent",
					getSessionFile: () => (fileBacked ? sessionId : undefined),
				},
				isIdle: () => true,
			},
		);
		registerSubagentNotify(pi as never, state);
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		const tracker = createAsyncJobTracker(pi, state, root, { widgetEnabled: false, pollIntervalMs: 50, resultsDir });
		const visibleControlNotices = new Set<string>();
		events.on("subagent:control-event", (details) =>
			handleSubagentControlNotice({ pi: pi as never, state, visibleControlNotices, details: details as never }),
		);
		events.on("subagent:async-complete", tracker.handleComplete);
		try {
			tracker.handleStarted({ id: runId, sessionId, asyncDir, agent: "Inspect lock" });
			watcher.primeExistingResults();
			await vi.advanceTimersByTimeAsync(100);
			expect(state.asyncJobs.get(runId)?.status).toBe("failed");
			expect(existsSync(file)).toBe(true);
			await vi.advanceTimersByTimeAsync(4000);
			writeFileSync(file, JSON.stringify(result));
			watcher.primeExistingResults();
			await vi.advanceTimersByTimeAsync(100);
			expect(existsSync(file)).toBe(false);
			expect(sendMessage).toHaveBeenCalledOnce();
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "subagent-notify",
					content: expect.stringContaining("Completion guard rejected missing edits."),
				}),
				{ triggerTurn: true },
			);
			expect(sendMessage.mock.calls[0]?.[0].content).toContain("Research report: add a lock later.");
			const revivedFile = join(resultsDir, `${runId}-revived.json`);
			writeFileSync(revivedFile, JSON.stringify({ ...result, id: `${runId}-revived` }));
			watcher.primeExistingResults();
			await vi.advanceTimersByTimeAsync(100);
			expect(sendMessage).toHaveBeenCalledTimes(2);
			expect(sendMessage.mock.calls.every((call) => call[1]?.triggerTurn === true)).toBe(true);
			expect(existsSync(revivedFile)).toBe(false);
		} finally {
			watcher.stopResultWatcher();
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			await handlers.get("session_shutdown")!();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([undefined, "another-owner"])(
	"preserves local relay delivery and retry ACK when notification owner is %s",
	async (ownerNotificationSessionId) => {
		vi.useFakeTimers();
		const emitter = new EventEmitter();
		let firstAck = true;
		const events = {
			on(name: string, handler: (data: unknown) => void) {
				emitter.on(name, handler);
				return () => {
					emitter.off(name, handler);
				};
			},
			emit(name: string, data: unknown) {
				if (name === "subagent:result-intercom-delivery" && firstAck) {
					firstAck = false;
					setTimeout(() => emitter.emit(name, data), 750);
				} else
					emitter.emit(
						name,
						name === "subagent:result-intercom" ? { ...(data as object), ownerNotificationSessionId } : data,
					);
			},
		};
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const sendMessage = vi.fn();
		const pi = {
			events,
			sendMessage,
			appendEntry: vi.fn(),
			getSessionName: () => "parent",
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerShortcut: vi.fn(),
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
			},
		};
		intercomExtension(pi as never);
		const ctx = {
			cwd: "test",
			model: { id: "test" },
			sessionManager: { getSessionId: () => "parent" },
			isIdle: () => true,
		};
		await handlers.get("session_start")!({}, ctx);
		try {
			const first = deliverSubagentIntercomMessageEvent(events, "parent", "result", 500, { requestId: "stable" });
			await vi.advanceTimersByTimeAsync(500);
			expect(await first).toBe(false);
			expect(
				await deliverSubagentIntercomMessageEvent(events, "parent", "result", 500, { requestId: "stable" }),
			).toBe(true);
			await vi.advanceTimersByTimeAsync(300);
			expect(sendMessage).toHaveBeenCalledOnce();
			sendMessage.mockClear();
			for (const reason of ["idle", "time_threshold", "turn_threshold", "token_threshold", "completion_guard"]) {
				events.emit("subagent:control-intercom", {
					to: "parent",
					message: "Diagnostic only",
					event: { type: "needs_attention", reason },
				});
			}
			await vi.advanceTimersByTimeAsync(300);
			expect(sendMessage).not.toHaveBeenCalled();
			events.emit("subagent:control-intercom", {
				to: "parent",
				message: "Repeated tool failures",
				event: { type: "needs_attention", reason: "tool_failures" },
			});
			await vi.advanceTimersByTimeAsync(300);
			expect(sendMessage).toHaveBeenCalledOnce();
			expect(sendMessage.mock.calls[0]?.[0].content).toContain("Repeated tool failures");
		} finally {
			await handlers.get("session_shutdown")!();
		}
	},
);
