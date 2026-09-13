import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerSubagentNotify from "../src/builtin-extensions/pi-subagents/src/runs/background/notify.ts";
import { createResultWatcher } from "../src/builtin-extensions/pi-subagents/src/runs/background/result-watcher.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(status = "complete") {
	vi.useFakeTimers();
	const dir = mkdtempSync(join(tmpdir(), "lunr-result-delivery-"));
	const file = join(dir, "result.json");
	const result = {
		id: "run",
		sessionId: "session",
		state: status,
		success: status === "complete",
		summary: "Finished",
		nestedChildren: [],
		intercomTarget: "parent",
	};
	writeFileSync(file, JSON.stringify(result));
	const emitter = new EventEmitter();
	const events = {
		on(name: string, listener: (data: unknown) => void) {
			emitter.on(name, listener);
			return () => {
				emitter.off(name, listener);
			};
		},
		emit(name: string, data: unknown) {
			emitter.emit(name, data);
		},
	};
	const state = { currentSessionId: "session", completionSeen: new Map() } as unknown as SubagentState;
	const appendEntry = vi.fn();
	const watcher = createResultWatcher({ events, appendEntry }, state, dir, 60_000);
	cleanups.push(() => {
		watcher.stopResultWatcher();
		rmSync(dir, { recursive: true, force: true });
	});
	return { file, state, events, watcher, appendEntry, result };
}

describe("async result delivery", () => {
	it("records a stopped notification without waking the parent or attempting intercom", async () => {
		const { watcher, events, state, file } = fixture("stopped");
		const sendMessage = vi.fn();
		const relay = vi.fn();
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, relay);
		registerSubagentNotify({ events, sendMessage } as never, state);
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(100);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("stopped:") }),
			{ triggerTurn: false },
		);
		expect(relay).not.toHaveBeenCalled();
		expect(existsSync(file)).toBe(false);
	});

	it("delivers failure evidence to the owner even when the external relay never acknowledges", async () => {
		const { watcher, events, state, file, result } = fixture("failed");
		const results = [
			{
				agent: "Inspect lock",
				success: false,
				error: "Missing required verification.",
				output: "Report: the lock is process-local.",
				acceptance: {
					childReport: {
						reviewFindings: ["Use a cross-process lock."],
						residualRisks: ["Concurrent writes remain possible."],
					},
				},
			},
		];
		writeFileSync(file, JSON.stringify({ ...result, id: "failed-evidence", results }));
		const sendMessage = vi.fn();
		const relay = vi.fn();
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, relay);
		registerSubagentNotify({ events, sendMessage } as never, state);
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				content: expect.stringContaining(
					"Missing required verification.\n\nOutput:\nReport: the lock is process-local.",
				),
			}),
			{ triggerTurn: true },
		);
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("```acceptance-report");
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("Concurrent writes remain possible.");
		expect(relay).toHaveBeenCalledTimes(3);
		expect(relay.mock.calls[0]?.[0]).toMatchObject({ ownerNotificationSessionId: "session", to: "parent" });
		expect(existsSync(file)).toBe(true);
	});

	it("keeps each child's recovery details in the sole owner notification", async () => {
		const { watcher, events, state, file, result } = fixture("failed");
		const results = ["first", "second"].map((name, index) => {
			const sessionFile = join(file, "..", `${name}-session.jsonl`);
			const outputPath = join(file, "..", `${name}-output.md`);
			writeFileSync(sessionFile, "");
			return {
				agent: `Inspect ${name}`,
				success: index === 0,
				output: `${name} findings`,
				sessionFile,
				artifactPaths: { outputPath },
			};
		});
		writeFileSync(file, JSON.stringify({ ...result, id: "parallel-recovery", mode: "parallel", results }));
		const sendMessage = vi.fn();
		registerSubagentNotify({ events, sendMessage } as never, state);
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(100);
		expect(sendMessage).toHaveBeenCalledOnce();
		const content = sendMessage.mock.calls[0]?.[0].content;
		expect(content).toContain("Run: parallel-recovery");
		for (const [index, child] of results.entries()) {
			expect(content).toContain(`${index + 1}. ${child.agent} [${child.success ? "completed" : "failed"}]`);
			expect(content).toContain(child.sessionFile);
			expect(content).toContain(child.artifactPaths.outputPath);
			expect(content).toContain(`id: "parallel-recovery", index: ${index}`);
		}
	});

	it("updates terminal state immediately and retains unacknowledged output without writing over the TUI", async () => {
		const { watcher, events, file } = fixture();
		const complete = vi.fn();
		events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, complete);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(100);
		expect(complete).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(500);
		expect(stderr).not.toHaveBeenCalled();
		expect(existsSync(file)).toBe(true);
	});

	it("retries with the same delivery identity without repeating completion", async () => {
		const { watcher, events, file } = fixture();
		const requests: string[] = [];
		const complete = vi.fn();
		events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, complete);
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (value) => {
			const request = value as { requestId: string };
			requests.push(request.requestId);
			if (requests.length === 2)
				events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
		});
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toBe(requests[1]);
		expect(complete).toHaveBeenCalledOnce();
		expect(existsSync(file)).toBe(false);
	});

	it("bounds failed attempts and keeps recoverable output", async () => {
		const { watcher, events, file, appendEntry } = fixture();
		const relay = vi.fn();
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, relay);
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(10_000);
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(relay).toHaveBeenCalledTimes(3);
		expect(appendEntry).toHaveBeenCalledTimes(3);
		expect(existsSync(file)).toBe(true);
	});

	it("does not delete pending output after the watcher is stopped during delivery", async () => {
		const { watcher, events, file } = fixture();
		events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (value) => {
			const request = value as { requestId: string };
			setTimeout(
				() =>
					events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true }),
				200,
			);
		});
		watcher.primeExistingResults();
		await vi.advanceTimersByTimeAsync(100);
		watcher.stopResultWatcher();
		await vi.advanceTimersByTimeAsync(500);
		expect(existsSync(file)).toBe(true);
	});
});
