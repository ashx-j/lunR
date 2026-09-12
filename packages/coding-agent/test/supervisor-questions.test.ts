import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	askRunningAsyncChild,
	reconcileAsyncQuestion,
	resolveAskChild,
} from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-ask.ts";
import {
	answerSupervisorQuestion,
	cancelPendingSupervisorQuestionsForOwner,
	cancelSupervisorQuestion,
	createSupervisorQuestion,
	expireSupervisorQuestion,
	formatParentQuestionForChild,
	markSupervisorQuestionDelivered,
	readSupervisorQuestion,
	resetSupervisorQuestionTestState,
	resolveSupervisorChannelDir,
	supervisorQuestionPublicState,
} from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-questions.ts";
import { writeSteerCapability } from "../src/builtin-extensions/pi-subagents/src/runs/background/control-channel.ts";
import { writeAtomicJson } from "../src/builtin-extensions/pi-subagents/src/shared/atomic-json.ts";
import type { AsyncStatus, SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { ASYNC_DIR } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

const temps: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	resetSupervisorQuestionTestState();
	for (const dir of temps.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("supervisor question store", () => {
	it("uses immutable side files and rejects late duplicate answers", () => {
		const channelDir = tempDir("sup-q-");
		const owner = { runId: "run-a", childIndex: 0, childId: "child-a", pid: 4242, readyAt: 1000 };
		const question = createSupervisorQuestion({
			channelDir,
			reason: "choose package manager",
			message: "npm or pnpm?",
			runId: owner.runId,
			childIndex: owner.childIndex,
			childId: owner.childId,
			parentSessionId: "session-1",
			parentGeneration: 1,
			childIncarnation: { pid: owner.pid, readyAt: owner.readyAt },
			timeoutMs: 60_000,
		});
		expect(supervisorQuestionPublicState(question)).toBe("pending");
		expect(fs.existsSync(path.join(channelDir, "questions", `${question.id}.json`))).toBe(true);

		const delivered = markSupervisorQuestionDelivered(channelDir, question.id, owner);
		expect(delivered?.deliveredAt).toBeTypeOf("number");
		expect(supervisorQuestionPublicState(delivered!)).toBe("pending");

		const answered = answerSupervisorQuestion(channelDir, question.id, "use pnpm", owner);
		expect(supervisorQuestionPublicState(answered)).toBe("answered");
		expect(answered.answer).toBe("use pnpm");
		expect(fs.existsSync(path.join(channelDir, "questions", `${question.id}.terminal.json`))).toBe(true);

		expect(() => answerSupervisorQuestion(channelDir, question.id, "use npm instead", owner)).toThrow(
			/already answered/,
		);
		const latePath = path.join(channelDir, "questions", `${question.id}.late.json`);
		expect(fs.existsSync(latePath)).toBe(true);
		expect(readSupervisorQuestion(channelDir, question.id)?.answer).toBe("use pnpm");
	});

	it("rejects wrong incarnation and expired answers without overwriting", () => {
		const channelDir = tempDir("sup-q-inc-");
		const owner = { runId: "run-b", childIndex: 1, childId: "child-b", pid: 7, readyAt: 55 };
		const question = createSupervisorQuestion({
			channelDir,
			reason: "pick branch",
			message: "main or feat?",
			runId: owner.runId,
			childIndex: owner.childIndex,
			childId: owner.childId,
			parentSessionId: "session-2",
			parentGeneration: 0,
			childIncarnation: { pid: owner.pid, readyAt: owner.readyAt },
			now: 1_000,
			timeoutMs: 10,
			id: "q-expire",
		});
		expect(() => answerSupervisorQuestion(channelDir, question.id, "main", { ...owner, readyAt: 99 }, 1_005)).toThrow(
			/different child incarnation/,
		);
		const expired = expireSupervisorQuestion(channelDir, question.id, 1_020);
		expect(supervisorQuestionPublicState(expired!)).toBe("expired");
		expect(() => answerSupervisorQuestion(channelDir, question.id, "too late", owner, 1_030)).toThrow(
			/expired|no longer accepts/,
		);
	});

	it("cancels pending questions for session/run owners", () => {
		const channelDir = resolveSupervisorChannelDir("run-c", "worker", 0);
		temps.push(channelDir);
		fs.rmSync(channelDir, { recursive: true, force: true });
		const question = createSupervisorQuestion({
			channelDir,
			reason: "need flag",
			message: "on or off?",
			runId: "run-c",
			childIndex: 0,
			childId: "worker",
			parentSessionId: "sess-c",
			parentGeneration: 3,
		});
		expect(cancelPendingSupervisorQuestionsForOwner({ parentSessionId: "", reason: "unbound session" })).toEqual([]);
		expect(readSupervisorQuestion(channelDir, question.id)?.cancelledAt).toBeUndefined();
		const cancelled = cancelPendingSupervisorQuestionsForOwner({
			parentSessionId: "sess-c",
			parentGeneration: 3,
			runId: "run-c",
			reason: "async run settled",
		});
		expect(cancelled).toHaveLength(1);
		expect(supervisorQuestionPublicState(readSupervisorQuestion(channelDir, question.id)!)).toBe("cancelled");
	});
});

describe("parent ask targeting", () => {
	it("requires integer index and does not treat another run's child as a deadlock", () => {
		const status = {
			runId: "run-target",
			sessionId: "sess",
			state: "running",
			mode: "parallel",
			startedAt: Date.now(),
			steps: [
				{ agent: "a", childId: "a", status: "running" },
				{ agent: "b", childId: "b", status: "running" },
			],
		} as AsyncStatus;
		expect(() => resolveAskChild(status, { index: 1.5 })).toThrow(/non-negative integer/);
		const child = resolveAskChild(status, { index: 1 });
		expect(child).toEqual({ index: 1, childId: "b", agent: "b" });
	});

	it("fail-closes without session id and rejects duplicate outstanding asks", () => {
		const asyncDir = path.join(ASYNC_DIR, `ask-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(asyncDir, { recursive: true });
		temps.push(asyncDir);
		const status: AsyncStatus = {
			runId: path.basename(asyncDir),
			sessionId: "sess-ask",
			state: "running",
			mode: "single",
			startedAt: Date.now(),
			steps: [{ agent: "worker", childId: "worker", status: "running" }],
		};
		writeAtomicJson(path.join(asyncDir, "status.json"), status);
		writeSteerCapability(asyncDir, { index: 0, pid: process.pid, readyAt: Date.now(), supported: true });

		const state = {
			currentSessionId: "sess-ask",
			sessionGeneration: 1,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
		} as unknown as SubagentState;

		temps.push(resolveSupervisorChannelDir(status.runId, "worker", 0));
		const first = askRunningAsyncChild({
			params: {
				id: status.runId,
				index: 0,
				reason: "decide transport",
				message: "http or stdio?",
			},
			state,
		});
		expect(first.details.questionId).toBeTypeOf("string");
		expect(first.details.answered).toBe(false);

		expect(() =>
			askRunningAsyncChild({
				params: {
					id: status.runId,
					index: 0,
					reason: "decide transport again",
					message: "still waiting",
				},
				state,
			}),
		).toThrow(/already outstanding/);

		expect(() =>
			askRunningAsyncChild({
				params: {
					id: status.runId,
					reason: "missing session",
					message: "x",
				},
				state: { ...state, currentSessionId: null },
			}),
		).toThrow(/active session identity/);
	});

	it("deadlocks only when the same run child is waiting on the parent", () => {
		const asyncDir = path.join(ASYNC_DIR, `ask-dead-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(asyncDir, { recursive: true });
		temps.push(asyncDir);
		const status: AsyncStatus = {
			runId: path.basename(asyncDir),
			sessionId: "sess-dead",
			state: "running",
			mode: "single",
			startedAt: Date.now(),
			steps: [{ agent: "worker", childId: "worker", status: "running" }],
		};
		writeAtomicJson(path.join(asyncDir, "status.json"), status);
		writeSteerCapability(asyncDir, { index: 0, pid: process.pid, readyAt: Date.now(), supported: true });
		const state = {
			currentSessionId: "sess-dead",
			sessionGeneration: 0,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
		} as unknown as SubagentState;

		temps.push(resolveSupervisorChannelDir(status.runId, "worker", 0));
		const otherRunOk = askRunningAsyncChild({
			params: { id: status.runId, reason: "pick", message: "a or b?" },
			state,
			childRequests: [{ expectsReply: true, runId: "other-run", childIndex: 0, agent: "worker" }],
		});
		expect(otherRunOk.details.questionId).toBeTypeOf("string");
		cancelSupervisorQuestion(
			resolveSupervisorChannelDir(status.runId, "worker", 0),
			String(otherRunOk.details.questionId),
			"test reset",
		);

		expect(() =>
			askRunningAsyncChild({
				params: { id: status.runId, reason: "pick again", message: "c or d?" },
				state,
				childRequests: [{ expectsReply: true, runId: status.runId, childIndex: 0, agent: "worker" }],
			}),
		).toThrow(/deadlock/);
	});
});

describe("running child lifecycle", () => {
	function runningChild() {
		const runId = `question-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const channelDir = resolveSupervisorChannelDir(runId, "private-a", 0);
		temps.push(asyncDir, channelDir);
		const status: AsyncStatus = {
			runId,
			sessionId: runId,
			state: "running",
			mode: "parallel",
			startedAt: Date.now(),
			steps: [
				{ agent: "same label", childId: "private-a", status: "running" },
				{ agent: "same label", childId: "private-b", status: "running" },
			],
		};
		writeAtomicJson(path.join(asyncDir, "status.json"), status);
		writeSteerCapability(asyncDir, { index: 0, pid: process.pid, readyAt: 100, supported: true });
		const state = {
			currentSessionId: runId,
			sessionGeneration: 0,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
		} as unknown as SubagentState;
		const ask = () =>
			askRunningAsyncChild({
				params: { id: runId, index: 0, reason: "choose API", message: "Does the API support retries?" },
				state,
			});
		return { asyncDir, channelDir, status, state, ask };
	}

	it("rejects unpolled blocking requests on disk and unsupported delivery", () => {
		const f = runningChild();
		const requestFile = path.join(f.channelDir, "requests", "blocking.json");
		writeAtomicJson(requestFile, {
			type: "subagent.supervisor.request",
			id: "blocking",
			expectsReply: true,
			runId: f.status.runId,
			childIndex: 0,
		});
		expect(f.ask).toThrow(/waiting for a supervisor reply/);
		fs.rmSync(requestFile);
		writeSteerCapability(f.asyncDir, { index: 0, pid: process.pid, readyAt: 100, supported: false });
		expect(f.ask).toThrow(/not ready/);
	});

	it.each(["step finished", "delivery failed", "child replaced"])(
		"cancels when %s while the other child keeps running",
		(condition) => {
			const f = runningChild();
			expect(() => resolveAskChild(f.status, {})).toThrow(/broadcast/);
			expect(resolveAskChild(f.status, { childId: "private-b" }).index).toBe(1);
			const result = f.ask();
			const id = String(result.details.questionId);
			const question = readSupervisorQuestion(f.channelDir, id)!;
			if (condition === "step finished") f.status.steps![0]!.status = "complete";
			if (condition === "delivery failed") {
				f.status.steering = {
					requested: 1,
					scheduled: 0,
					pending: 0,
					delivered: 0,
					failed: 1,
					recovered: 0,
					recent: [
						{
							id,
							requestedAt: Date.now(),
							messagePreview: "question",
							targets: [{ index: 0, state: "failed", reason: "inbox unavailable" }],
						},
					],
				};
			}
			if (condition === "child replaced")
				writeSteerCapability(f.asyncDir, { index: 0, pid: process.pid, readyAt: 200, supported: true });
			writeAtomicJson(path.join(f.asyncDir, "status.json"), f.status);
			expect(supervisorQuestionPublicState(reconcileAsyncQuestion(f.channelDir, question, f.state))).toBe(
				"cancelled",
			);
			expect(f.status.steps![1]!.status).toBe("running");
		},
	);
});

describe("format helpers", () => {
	it("keeps parent question formatting reply-linked", () => {
		const text = formatParentQuestionForChild({
			type: "subagent.supervisor.question",
			id: "qid-1",
			createdAt: 1,
			expiresAt: 2,
			reason: "choose API",
			message: "REST or RPC?",
			runId: "r",
			childIndex: 0,
			childId: "c",
			parentSessionId: "s",
			parentGeneration: 0,
		});
		expect(text).toContain("Parent question (qid-1)");
		expect(text).toContain('replyTo: "qid-1"');
		expect(text).toContain("Continue the assigned task after replying");
	});
});
