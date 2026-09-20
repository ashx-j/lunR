import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import piIntercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";
import {
	CHILD_DESCRIPTION_ENV,
	SUPERVISOR_PROGRESS_TYPE,
	SUPERVISOR_PROTOCOL_ENV,
} from "../src/builtin-extensions/pi-subagents/src/intercom/communication.ts";
import {
	createNativeSupervisorChannel,
	hasPendingBlockingSupervisorRequest,
	registerNativeSupervisorClient,
} from "../src/builtin-extensions/pi-subagents/src/intercom/native-supervisor-channel.ts";
import { askRunningAsyncChild } from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-ask.ts";
import {
	answerSupervisorQuestion,
	claimQuestionNotification,
	createSupervisorQuestion,
	formatParentQuestionForChild,
	readSupervisorQuestion,
	registerQuestionWait,
	resetSupervisorQuestionTestState,
	resolveSupervisorChannelDir,
} from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-questions.ts";
import { drainOutstandingWork } from "../src/builtin-extensions/pi-subagents/src/runs/background/auto-drain.ts";
import {
	consumeSteerAcks,
	steerAcksDir,
	stopRequestPath,
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
import { convertToLlm } from "../src/core/messages.ts";
import { createHarnessWithExtensions } from "./test-harness.ts";

const temps: string[] = [];

it("yields headless auto-drain when communication queues a parent turn", async () => {
	const f = fixture();
	let pending = false;
	const timer = setTimeout(() => {
		pending = true;
	}, 20);
	try {
		await drainOutstandingWork({
			state: f.state,
			timeoutMs: 500,
			hasWork: () => true,
			hasPendingMessages: () => pending,
			wait: (params, signal, deps) => waitForSubagents(params, signal, { ...deps, pollIntervalMs: 5 }),
		});
		expect(pending).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(f.asyncDir, "status.json"), "utf8")).state).toBe("running");
	} finally {
		clearTimeout(timer);
	}
});

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
		description: string;
		parameters: unknown;
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
		) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown> }>;
	};
	const tools: RegisteredTool[] = [];
	const sendMessage = vi.fn();
	return {
		tools,
		sendMessage,
		appendEntry: vi.fn(),
		events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
		getAllTools: () => tools,
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		on: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerEntryRenderer: vi.fn(),
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
			expect(spawn.env[SUPERVISOR_PROTOCOL_ENV]).toBe("2");
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

	it.each(["2", ""])("separates new progress from legacy model messages, protocol=%s", async (protocol) => {
		const f = fixture(true);
		answerSupervisorQuestion(f.channelDir, f.question.id, "prior answer", f.owner);
		claimQuestionNotification(f.channelDir, f.question.id);
		const spawn = buildPiArgs({
			baseArgs: [],
			task: "Inspect lock",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			parentSessionId: f.runId,
			supervisorSessionId: f.state.currentSessionId!,
			runId: f.runId,
			childId: "child",
			childDescription: "Inspect lock",
			childIndex: 0,
		});
		for (const [key, value] of Object.entries(spawn.env)) vi.stubEnv(key, value);
		vi.stubEnv(SUPERVISOR_PROTOCOL_ENV, protocol);
		expect(spawn.env[CHILD_DESCRIPTION_ENV]).toBe("Inspect lock");
		const child = mockPi();
		registerNativeSupervisorClient(child as unknown as ExtensionAPI);
		const contact = child.tools.find((tool) => tool.name === "contact_supervisor")!;
		expect(contact.description).toContain(protocol ? "UI-only" : "legacy supervisor");
		expect(contact.parameters).toMatchObject({
			properties: {
				reason: {
					enum: protocol
						? ["need_decision", "interview_request", "progress_update", "handoff"]
						: ["need_decision", "interview_request", "progress_update"],
				},
			},
		});
		if (!protocol)
			await expect(
				contact.execute("unsupported", { reason: "handoff", message: "Dependency ready" }),
			).rejects.toThrow("legacy protocol");
		await contact.execute("progress", { reason: "progress_update", message: "routine-only-marker" });
		const parent = mockPi();
		const channel = createNativeSupervisorChannel(parent as unknown as ExtensionAPI, f.state);
		try {
			channel.start();
			if (protocol) {
				expect(parent.sendMessage).not.toHaveBeenCalled();
				expect(parent.appendEntry).toHaveBeenCalledExactlyOnceWith(
					SUPERVISOR_PROGRESS_TYPE,
					expect.objectContaining({
						communication: {
							direction: "from",
							peer: "Inspect lock",
							kind: "progress",
							message: "routine-only-marker",
						},
					}),
				);
			} else {
				expect(parent.appendEntry).not.toHaveBeenCalled();
				expect(parent.sendMessage).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ content: "From: Inspect lock\n\nroutine-only-marker" }),
					{ triggerTurn: false },
				);
			}
			expect(channel.pending.size).toBe(0);
			expect(parent.events.emit).not.toHaveBeenCalled();
		} finally {
			channel.dispose();
		}
	});

	it("delivers a dependency handoff without blocking the child or cancelling an outstanding parent question", async () => {
		const f = fixture();
		for (const [key, value] of Object.entries(
			buildPiArgs({
				baseArgs: [],
				task: "Inspect lock",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				parentSessionId: f.runId,
				runId: f.runId,
				childId: "child",
				childDescription: "Inspect lock",
				childIndex: 0,
			}).env,
		))
			vi.stubEnv(key, value);
		const child = mockPi();
		registerNativeSupervisorClient(child as unknown as ExtensionAPI);
		const result = await child.tools
			.find((tool) => tool.name === "contact_supervisor")!
			.execute("handoff", { reason: "handoff", message: "Capture contract is ready; implementation can proceed." });
		expect(result.content[0]?.text).toContain("Continue independent work");
		const parent = mockPi();
		const channel = createNativeSupervisorChannel(parent as unknown as ExtensionAPI, f.state);
		try {
			channel.start();
			expect(parent.sendMessage).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ details: expect.objectContaining({ reason: "handoff", expectsReply: false }) }),
				{ triggerTurn: true },
			);
			expect(channel.pending.size).toBe(0);
			expect(readSupervisorQuestion(f.channelDir, f.question.id)?.cancelledAt).toBeUndefined();
		} finally {
			channel.dispose();
		}
	});

	it.each(["stopped", "stop-requested", "expired", "wrong-owner"])(
		"does not wake for a %s blocking request",
		(condition) => {
			const f = fixture(true);
			const requestFile = path.join(f.channelDir, "requests", "blocked.json");
			writeAtomicJson(requestFile, {
				type: "subagent.supervisor.request",
				protocolVersion: 2,
				id: "blocked",
				createdAt: Date.now(),
				expiresAt: condition === "expired" ? 1 : Date.now() + 60_000,
				reason: "need_decision",
				message: "Need approval",
				expectsReply: true,
				runId: f.runId,
				agent: "child",
				childIndex: 0,
				supervisorSessionId: condition === "wrong-owner" ? "other-session" : f.state.currentSessionId,
			});
			if (condition === "stopped")
				writeAtomicJson(path.join(f.asyncDir, "status.json"), { ...f.status, state: "stopped" });
			if (condition === "stop-requested")
				writeAtomicJson(stopRequestPath(f.asyncDir), { type: "stop", ts: Date.now() });
			const parent = mockPi();
			const channel = createNativeSupervisorChannel(parent as unknown as ExtensionAPI, f.state);
			try {
				channel.start();
				expect(parent.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
				expect(channel.pending.size).toBe(0);
			} finally {
				channel.dispose();
			}
		},
	);

	it("restores a delivered blocking request after reload without waking twice", () => {
		const f = fixture(true);
		writeAtomicJson(path.join(f.channelDir, "requests", "blocked.json"), {
			type: "subagent.supervisor.request",
			protocolVersion: 2,
			id: "blocked",
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			reason: "need_decision",
			message: "Need approval",
			expectsReply: true,
			runId: f.runId,
			agent: "child",
			childIndex: 0,
			supervisorSessionId: f.state.currentSessionId,
		});
		const parent = mockPi();
		Object.assign(f.state.lastUiContext!.sessionManager, {
			getBranch: () => parent.sendMessage.mock.calls.map(([message]) => ({ type: "custom_message", ...message })),
		});
		const channel = createNativeSupervisorChannel(parent as unknown as ExtensionAPI, f.state);
		try {
			channel.start();
			expect(parent.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ details: expect.objectContaining({ id: "blocked" }) }),
				{ triggerTurn: true },
			);
			channel.dispose();
			parent.sendMessage.mockClear();
			Object.assign(f.state.lastUiContext!.sessionManager, {
				getBranch: () => [
					{ type: "custom_message", customType: "subagent_supervisor_request", details: { id: "blocked" } },
				],
			});
			channel.start();
			expect(channel.pending.has("blocked")).toBe(true);
			expect(
				parent.sendMessage.mock.calls.some(([message]) => message.customType === "subagent_supervisor_request"),
			).toBe(false);
		} finally {
			channel.dispose();
		}
	});

	it("keeps UI progress out of provider and compaction input during an active turn and after context rebuild", async () => {
		const f = fixture(true);
		let channel: ReturnType<typeof createNativeSupervisorChannel> | undefined;
		const harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "probe", args: {} }] }, "finished"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Perform independent work",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							f.state.currentSessionId =
								ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
							f.state.lastUiContext = ctx;
							writeAtomicJson(path.join(f.channelDir, "requests", "progress.json"), {
								type: "subagent.supervisor.request",
								protocolVersion: 2,
								id: "progress",
								createdAt: Date.now(),
								reason: "progress_update",
								message: "ui-only-provider-marker",
								expectsReply: false,
								runId: f.runId,
								agent: "child",
								childIndex: 0,
								supervisorSessionId: f.state.currentSessionId,
							});
							channel = createNativeSupervisorChannel(pi, f.state);
							channel.start();
							return { content: [{ type: "text", text: "work done" }], details: {} };
						},
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			await harness.session.prompt("Perform independent work.");
			expect(harness.faux.callCount).toBe(2);
			expect(JSON.stringify(harness.faux.contexts)).not.toContain("ui-only-provider-marker");
			expect(JSON.stringify(harness.session.sessionManager.getEntries())).toContain("ui-only-provider-marker");
			expect(
				JSON.stringify(convertToLlm(harness.session.sessionManager.buildSessionContext().messages)),
			).not.toContain("ui-only-provider-marker");
		} finally {
			channel?.dispose();
			harness.cleanup();
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
