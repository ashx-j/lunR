import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import piIntercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";
import {
	createNativeSupervisorChannel,
	hasPendingBlockingSupervisorRequest,
	registerNativeSupervisorClient,
} from "../src/builtin-extensions/pi-subagents/src/intercom/native-supervisor-channel.ts";
import { askRunningAsyncChild } from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-ask.ts";
import {
	answerSupervisorQuestion,
	createSupervisorQuestion,
	formatParentQuestionForChild,
	readSupervisorQuestion,
	registerQuestionWait,
	resetSupervisorQuestionTestState,
	resolveSupervisorChannelDir,
} from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-questions.ts";
import {
	consumeSteerAcks,
	steerAcksDir,
	writeSteerCapability,
	writeSteerRequestToDir,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/control-channel.ts";
import {
	createSteeringStatus,
	recordSteeringRequest,
	updateSteeringTarget,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/steering.ts";
import { waitForSubagents } from "../src/builtin-extensions/pi-subagents/src/runs/background/subagent-wait.ts";
import { buildPiArgs } from "../src/builtin-extensions/pi-subagents/src/runs/shared/pi-args.ts";
import { registerSteeringInbox } from "../src/builtin-extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts";
import { writeAtomicJson } from "../src/builtin-extensions/pi-subagents/src/shared/atomic-json.ts";
import {
	ASYNC_DIR,
	type AsyncStatus,
	type SubagentState,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarnessWithExtensions } from "./test-harness.ts";

const temps: string[] = [];

function fixture(fileBacked = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-lifecycle-"));
	const runId = path.basename(root);
	const channelDir = resolveSupervisorChannelDir(runId, "child", 0);
	temps.push(root, channelDir);
	const owner = { runId, childId: "child", childIndex: 0, pid: process.pid, readyAt: Date.now() };
	const sessionFile = fileBacked ? path.join(root, "parent.jsonl") : undefined;
	const state = {
		currentSessionId: sessionFile ?? runId,
		sessionGeneration: 1,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastUiContext: { sessionManager: { getSessionId: () => runId, getSessionFile: () => sessionFile } },
	} as unknown as SubagentState;
	const asyncDir = path.join(ASYNC_DIR, runId);
	temps.push(asyncDir);
	const status: AsyncStatus = {
		runId,
		sessionId: sessionFile ?? runId,
		state: "running",
		mode: "single",
		startedAt: Date.now(),
		steps: [{ agent: "Inspect lock", childId: owner.childId, status: "running" }],
	};
	writeAtomicJson(path.join(asyncDir, "status.json"), status);
	writeSteerCapability(asyncDir, { index: 0, pid: owner.pid, readyAt: owner.readyAt, supported: true });
	const result = askRunningAsyncChild({
		state,
		params: {
			id: runId,
			index: 0,
			reason: "decide whether to reuse the existing lock",
			message: "Does the current lock cover multiple processes?",
		},
	});
	const question = readSupervisorQuestion(channelDir, String(result.details.questionId))!;
	return { root, runId, channelDir, owner, state, question, sessionFile, asyncDir, status };
}

function mockPi() {
	type RegisteredTool = {
		name: string;
		parameters: unknown;
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;
	};
	const tools: RegisteredTool[] = [];
	const sendMessage = vi.fn();
	return {
		tools,
		sendMessage,
		events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
		getAllTools: () => tools,
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		on: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
	};
}

afterEach(() => {
	resetSupervisorQuestionTestState();
	vi.unstubAllEnvs();
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("supervisor question integration", () => {
	it.each([false, true])(
		"receives and answers a question using spawn metadata, file-backed=%s",
		async (fileBacked) => {
			const f = fixture(fileBacked);
			const inbox = path.join(f.root, "inbox");
			const spawn = buildPiArgs({
				baseArgs: [],
				task: "Inspect the lock",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: false,
				parentSessionId: f.runId,
				supervisorSessionId: f.state.currentSessionId,
				runId: f.runId,
				childId: f.owner.childId,
				childIndex: 0,
			});
			for (const [key, value] of Object.entries(spawn.env)) vi.stubEnv(key, value);
			expect(spawn.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID).toBe(f.runId);
			vi.stubEnv("PI_SUBAGENT_STEER_INBOX", inbox);
			vi.stubEnv("PI_SUBAGENT_STEER_CAPABILITY", path.join(f.root, "capability.json"));
			vi.stubEnv("PI_SUBAGENT_STEER_ACK_DIR", path.join(f.root, "acks"));
			vi.stubEnv("PI_SUBAGENT_STEER_READY_AT", String(f.owner.readyAt));
			const order: string[] = [];
			const harness = await createHarnessWithExtensions({
				responses: [
					{ toolCalls: [{ name: "probe", args: { phase: "before" } }] },
					{
						toolCalls: [
							{
								name: "contact_supervisor",
								args: { action: "reply", replyTo: f.question.id, message: "Yes, keep the lock." },
							},
						],
					},
					{ toolCalls: [{ name: "probe", args: { phase: "after" } }] },
					"original task finished",
				],
				extensionFactories: [
					(pi) => {
						registerNativeSupervisorClient(pi, { includeIntercomFallback: false });
						registerSteeringInbox(pi);
						pi.registerTool({
							name: "probe",
							label: "Probe",
							description: "Observe original task progress",
							parameters: Type.Object({ phase: Type.String() }),
							async execute(_id, { phase }, signal) {
								order.push(phase);
								if (phase === "before") {
									writeSteerRequestToDir(inbox, {
										type: "steer",
										id: f.question.id,
										ts: Date.now(),
										message: formatParentQuestionForChild(f.question),
										targetIndex: 0,
										source: "supervisor-question",
									});
									await vi.waitFor(() =>
										expect(readSupervisorQuestion(f.channelDir, f.question.id)?.deliveredAt).toBeTypeOf(
											"number",
										),
									);
									expect(signal?.aborted).toBeFalsy();
								} else {
									expect(readSupervisorQuestion(f.channelDir, f.question.id)?.answer).toBe(
										"Yes, keep the lock.",
									);
								}
								return { content: [{ type: "text", text: phase }], details: {} };
							},
						});
					},
				],
			});
			try {
				await harness.session.bindExtensions({});
				await harness.session.prompt("Perform the original task.");
				expect(order).toEqual(["before", "after"]);
				expect(harness.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
				expect(JSON.stringify(harness.faux.contexts[1]?.messages)).toContain(f.question.id);
				expect(harness.faux.callCount).toBe(4);
				const parentPi = mockPi();
				const channel = createNativeSupervisorChannel(parentPi as unknown as ExtensionAPI, f.state);
				try {
					channel.start();
					expect(parentPi.sendMessage).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({ customType: "subagent_supervisor_answer" }),
						{ triggerTurn: true },
					);
				} finally {
					channel.dispose();
				}
			} finally {
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
			}
		},
	);

	it("rejects mismatched supervisor ownership and promptly reconciles the inbox failure without a wake", async () => {
		const f = fixture(true);
		const inbox = path.join(f.root, "inbox");
		const spawn = buildPiArgs({
			baseArgs: [],
			task: "Inspect lock",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: false,
			parentSessionId: f.runId,
			supervisorSessionId: f.runId,
			runId: f.runId,
			childId: f.owner.childId,
			childIndex: 0,
			steerInboxDir: inbox,
			steerCapabilityPath: path.join(f.root, "capability.json"),
			steerAckDir: steerAcksDir(f.asyncDir, 0),
		});
		for (const [key, value] of Object.entries(spawn.env)) vi.stubEnv(key, value);
		vi.stubEnv("PI_SUBAGENT_STEER_READY_AT", String(f.owner.readyAt));
		const harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ name: "probe", args: {} }] },
				{
					toolCalls: [
						{
							name: "contact_supervisor",
							args: { action: "reply", replyTo: f.question.id, message: "Wrong-owner answer" },
						},
					],
				},
				"original task finished",
			],
			extensionFactories: [
				(pi) => {
					registerNativeSupervisorClient(pi, { includeIntercomFallback: false });
					registerSteeringInbox(pi);
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Check failed delivery",
						parameters: Type.Object({}),
						async execute(_id, _args, signal) {
							writeSteerRequestToDir(inbox, {
								type: "steer",
								id: f.question.id,
								ts: Date.now(),
								message: formatParentQuestionForChild(f.question),
								targetIndex: 0,
								source: "supervisor-question",
							});
							let acks: ReturnType<typeof consumeSteerAcks> = [];
							await vi.waitFor(() => {
								acks = consumeSteerAcks(f.asyncDir);
								expect(acks).toHaveLength(1);
							});
							expect(acks[0]?.state).toBe("failed");
							expect(signal?.aborted).toBeFalsy();
							f.status.steering = createSteeringStatus();
							recordSteeringRequest(f.status.steering, {
								id: f.question.id,
								requestedAt: Date.now(),
								source: "supervisor-question",
								message: "question",
								targets: [{ index: 0, state: "routed" }],
							});
							updateSteeringTarget(f.status.steering, f.question.id, 0, "failed", Date.now(), {
								reason: acks[0]!.message,
							});
							writeAtomicJson(path.join(f.asyncDir, "status.json"), f.status);
							return { content: [{ type: "text", text: "continuing original task" }], details: {} };
						},
					});
				},
			],
		});
		const pi = mockPi();
		const channel = createNativeSupervisorChannel(pi as unknown as ExtensionAPI, f.state);
		try {
			await harness.session.bindExtensions({});
			await harness.session.prompt("Inspect lock");
			expect(JSON.stringify(harness.eventsOfType("tool_execution_end"))).toContain("different supervisor session");
			channel.start();
			expect(readSupervisorQuestion(f.channelDir, f.question.id)).toMatchObject({
				cancelReason: "Question is no longer pending for this child.",
			});
			expect(readSupervisorQuestion(f.channelDir, f.question.id)?.deliveredAt).toBeUndefined();
			expect(pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ details: expect.objectContaining({ state: "cancelled" }) }),
				{ triggerTurn: false },
			);
			expect(f.status.state).toBe("running");
		} finally {
			channel.dispose();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("keeps the question-aware child tool when intercom also loads", () => {
		const f = fixture();
		vi.stubEnv("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR", f.channelDir);
		vi.stubEnv("PI_SUBAGENT_RUN_ID", f.runId);
		vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "child");
		vi.stubEnv("PI_SUBAGENT_CHILD_INDEX", "0");
		vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", f.runId);
		vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_TARGET", "parent");
		const pi = mockPi();
		piIntercomExtension(pi as unknown as ExtensionAPI);
		registerNativeSupervisorClient(pi as unknown as ExtensionAPI, { includeIntercomFallback: false });
		const contacts = pi.tools.filter((tool) => tool.name === "contact_supervisor");
		expect(contacts).toHaveLength(1);
		expect(contacts[0]?.parameters).toMatchObject({
			properties: { action: { enum: ["reply"] }, replyTo: { type: "string" } },
		});
	});

	it("wakes an idle parent once, but leaves an active question wait as the answer path", async () => {
		const f = fixture();
		answerSupervisorQuestion(f.channelDir, f.question.id, "keep the lock", f.owner);
		const pi = mockPi();
		const channel = createNativeSupervisorChannel(pi as unknown as ExtensionAPI, f.state);
		const release = registerQuestionWait([f.question.id]);
		try {
			channel.start();
			expect(pi.tools.find((tool) => tool.name === "subagent_supervisor")?.parameters).toMatchObject({
				properties: { action: { enum: ["list", "ask", "reply", "pending", "status"] }, reason: { type: "string" } },
			});
			expect(pi.sendMessage).not.toHaveBeenCalled();
			release();
			channel.dispose();
			channel.start();
			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "subagent_supervisor_answer" }),
				{ triggerTurn: true },
			);
			channel.dispose();
			channel.start();
			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		} finally {
			release();
			channel.dispose();
		}
	});

	it("keeps a replaced parent generation from consuming or cancelling an earlier question", () => {
		const f = fixture(true);
		f.state.sessionGeneration = 2;
		const pi = mockPi();
		const channel = createNativeSupervisorChannel(pi as unknown as ExtensionAPI, f.state);
		try {
			channel.start();
			channel.cancelOwnedQuestions("replacement session");
			expect(readSupervisorQuestion(f.channelDir, f.question.id)?.cancelledAt).toBeUndefined();
			answerSupervisorQuestion(f.channelDir, f.question.id, "Earlier generation answer", f.owner);
			channel.dispose();
			channel.start();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		} finally {
			channel.dispose();
		}
	});

	it("settles a stopped run's question without restarting the parent", () => {
		const f = fixture();
		const pi = mockPi();
		const channel = createNativeSupervisorChannel(pi as unknown as ExtensionAPI, f.state);
		try {
			channel.settleRunQuestions(f.runId, "async run settled");
			channel.start();
			expect(pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ display: false, details: expect.objectContaining({ state: "cancelled" }) }),
				{ triggerTurn: false },
			);
		} finally {
			channel.dispose();
		}
	});

	it.each([
		{ reason: "need_decision", fileBacked: false },
		{ reason: "need_decision", fileBacked: true },
		{ reason: "interview_request", fileBacked: false },
		{ reason: "interview_request", fileBacked: true },
	])("preserves child-to-parent $reason and replies, file-backed=$fileBacked", async ({ reason, fileBacked }) => {
		const f = fixture(fileBacked);
		answerSupervisorQuestion(f.channelDir, f.question.id, "prior question answered", f.owner);
		vi.stubEnv("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR", f.channelDir);
		vi.stubEnv("PI_SUBAGENT_RUN_ID", f.runId);
		vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "child");
		vi.stubEnv("PI_SUBAGENT_CHILD_INDEX", "0");
		vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", f.runId);
		vi.stubEnv("PI_SUBAGENT_SUPERVISOR_SESSION_ID", f.state.currentSessionId!);
		const childPi = mockPi();
		registerNativeSupervisorClient(childPi as unknown as ExtensionAPI, { includeIntercomFallback: false });
		const childReply = childPi.tools
			.find((tool) => tool.name === "contact_supervisor")!
			.execute("ask", { reason, message: "Choose the public API", interview: { question: "Which API?" } });
		const parentPi = mockPi();
		const channel = createNativeSupervisorChannel(parentPi as unknown as ExtensionAPI, f.state);
		try {
			const pendingForOwner = hasPendingBlockingSupervisorRequest(f.runId, f.state.currentSessionId);
			channel.start();
			expect(channel.pending.size).toBe(1);
			const replyTo = [...channel.pending.keys()][0];
			await parentPi.tools
				.find((tool) => tool.name === "subagent_supervisor")!
				.execute("answer", { action: "reply", replyTo, message: '{"answer":"keep"}' });
			expect((await childReply).content[0]?.text).toContain('{"answer":"keep"}');
			expect(pendingForOwner).toBe(true);
		} finally {
			channel.dispose();
		}
	});

	it("expires questions inside wait without a running channel poller", async () => {
		const f = fixture();
		const expired = createSupervisorQuestion({
			channelDir: f.channelDir,
			...f.owner,
			parentSessionId: f.runId,
			parentGeneration: 1,
			reason: "decision",
			message: "question",
			now: 1,
			timeoutMs: 1,
		});
		const result = await waitForSubagents({ questionId: expired.id, timeoutMs: 500 }, undefined, { state: f.state });
		expect(result.details.state).toBe("expired");
	});
});
