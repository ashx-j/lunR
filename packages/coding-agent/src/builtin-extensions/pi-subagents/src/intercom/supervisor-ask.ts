import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readSteerCapability, requestAsyncSteer } from "../runs/background/control-channel.ts";
import { resolveSubagentRunId } from "../runs/background/run-id-resolver.ts";
import { readStatus } from "../shared/utils.ts";
import type { AsyncStatus, SubagentState } from "../shared/types.ts";
import {
	cancelSupervisorQuestion,
	createSupervisorQuestion,
	formatParentQuestionForChild,
	expireSupervisorQuestion,
	hasOutstandingQuestionForChild,
	hasBlockingSupervisorRequest,
	incarnationMatches,
	readSupervisorQuestion,
	supervisorQuestionIsTerminal,
	resolveSupervisorChannelDir,
	type SupervisorChildIncarnation,
	type SupervisorQuestion,
} from "./supervisor-questions.ts";

export interface ParentAskParams {
	id?: string;
	index?: number;
	childId?: string;
	reason?: string;
	message?: string;
}

export interface ParentAskRequestFile {
	expectsReply?: boolean;
	runId?: string;
	childIndex?: number;
	agent?: string;
	childTarget?: string;
}

function runningSteps(status: AsyncStatus): Array<{ index: number; childId: string; agent: string }> {
	return (status.steps ?? [])
		.map((step, index) => ({
			index,
			childId: step.childId ?? step.agent,
			agent: step.agent,
			status: step.status,
		}))
		.filter((step) => step.status === "running")
		.map((step) => ({ index: step.index, childId: step.childId, agent: step.agent }));
}

export function resolveAskChild(
	status: AsyncStatus,
	params: Pick<ParentAskParams, "index" | "childId">,
): { index: number; childId: string; agent: string } {
	if (params.index !== undefined && (!Number.isInteger(params.index) || params.index < 0)) {
		throw new Error("index must be a non-negative integer.");
	}
	const running = runningSteps(status);
	if (params.childId?.trim()) {
		const childId = params.childId.trim();
		const matches = (status.steps ?? [])
			.map((step, index) => ({ index, childId: step.childId ?? step.agent, agent: step.agent, status: step.status }))
			.filter((step) => step.childId === childId);
		if (matches.length === 0) throw new Error(`Async run '${status.runId}' has no child '${childId}'.`);
		if (matches.length > 1) throw new Error(`Async run '${status.runId}' has multiple children named '${childId}'. Pass index.`);
		const match = matches[0]!;
		if (params.index !== undefined && params.index !== match.index) {
			throw new Error(`Child '${childId}' is index ${match.index}, not ${params.index}.`);
		}
		if (match.status !== "running") throw new Error(`Async run '${status.runId}' child ${match.index} is ${match.status} and cannot be asked.`);
		return { index: match.index, childId: match.childId, agent: match.agent };
	}
	if (params.index !== undefined) {
		const steps = status.steps ?? [];
		if (params.index >= steps.length) {
			throw new Error(`Async run '${status.runId}' has ${steps.length} children. Index ${params.index} is out of range.`);
		}
		const step = steps[params.index]!;
		if (step.status !== "running") throw new Error(`Async run '${status.runId}' child ${params.index} is ${step.status} and cannot be asked.`);
		return { index: params.index, childId: step.childId ?? step.agent, agent: step.agent };
	}
	if (running.length === 1) return running[0]!;
	if (running.length === 0) throw new Error(`Async run '${status.runId}' has no running child to ask.`);
	throw new Error(`Async run '${status.runId}' has ${running.length} running children. Pass index or childId; broadcast asks are not supported.`);
}

function requestMatchesChild(request: ParentAskRequestFile, runId: string, child: { index: number; childId: string; agent: string }): boolean {
	if (!request.expectsReply) return false;
	if (typeof request.runId !== "string" || request.runId !== runId) return false;
	const indexMatches = Number.isInteger(request.childIndex) && request.childIndex === child.index;
	const idMatches = request.agent === child.childId
		|| request.agent === child.agent
		|| request.childTarget === child.childId;
	return indexMatches && idMatches;
}

export function reconcileAsyncQuestion(channelDir: string, question: SupervisorQuestion, state: SubagentState): SupervisorQuestion {
	expireSupervisorQuestion(channelDir, question.id);
	const current = readSupervisorQuestion(channelDir, question.id) ?? question;
	if (supervisorQuestionIsTerminal(current)) return current;
	const resolved = resolveSubagentRunId(current.runId, { state });
	if (resolved?.kind !== "async" || !resolved.location.asyncDir) return current;
	const status = readStatus(resolved.location.asyncDir);
	if (!status) return current;
	const step = status.steps?.[current.childIndex];
	const capability = readSteerCapability(resolved.location.asyncDir, current.childIndex);
	let reason: string | undefined;
	if (status.sessionId !== current.parentSessionId) reason = "async run ownership changed";
	else if (status.state !== "running" || !step || step.status !== "running") reason = "target child is no longer running";
	else if ((step.childId ?? step.agent) !== current.childId) reason = "target child identity changed";
	else if (capability && !incarnationMatches(current.childIncarnation, capability)) reason = "target child process changed";
	else if (capability && !capability.supported) reason = "target child no longer accepts questions";
	const delivery = status.steering?.recent.find((request) => request.id === current.id)?.targets.find((target) => target.index === current.childIndex);
	if (delivery?.state === "failed" || delivery?.state === "late") reason = delivery.reason ?? "question delivery failed";
	return reason ? cancelSupervisorQuestion(channelDir, current.id, reason) ?? current : current;
}

export function askRunningAsyncChild(input: {
	params: ParentAskParams;
	state: SubagentState;
	childRequests?: Iterable<ParentAskRequestFile>;
}): AgentToolResult<Record<string, unknown>> {
	const runId = input.params.id?.trim();
	if (!runId) throw new Error("action='ask' requires id for the async run.");
	const reason = input.params.reason?.trim();
	const message = input.params.message?.trim();
	if (!reason) throw new Error("action='ask' requires reason naming the concrete decision the child's answer will change.");
	if (!message) throw new Error("action='ask' requires message.");
	const sessionId = input.state.currentSessionId;
	if (!sessionId) throw new Error("action='ask' requires an active session identity.");

	const resolved = resolveSubagentRunId(runId, { state: input.state });
	if (!resolved) throw new Error(`No async run matched '${runId}'.`);
	if (resolved.kind !== "async") throw new Error("action='ask' targets a running async child only. It does not revive, reassign, or broadcast.");
	if (!resolved.location.asyncDir) throw new Error(`Async run '${resolved.id}' has no live run directory.`);

	const status = readStatus(resolved.location.asyncDir);
	if (!status) throw new Error(`Async run '${resolved.id}' has no status.`);
	if (!status.sessionId || status.sessionId !== sessionId) {
		throw new Error(`Async run '${resolved.id}' was not found in the active session.`);
	}
	if (status.state !== "running") throw new Error(`Async run '${resolved.id}' is ${status.state} and cannot be asked.`);

	const child = resolveAskChild(status, input.params);
	const channelDir = resolveSupervisorChannelDir(status.runId, child.childId, child.index);
	if (hasOutstandingQuestionForChild(channelDir, child.index, child.childId)) {
		throw new Error(`A question is already outstanding for async run '${status.runId}' child ${child.index}. Wait for that answer or expiry before asking again.`);
	}
	for (const request of input.childRequests ?? []) {
		if (requestMatchesChild(request, status.runId, child)) {
			throw new Error(`Child ${child.index} is waiting for a supervisor reply. Asking now would deadlock. Reply to the child request first.`);
		}
	}

	if (hasBlockingSupervisorRequest(channelDir, status.runId, child.index)) {
		throw new Error("Child is waiting for a supervisor reply. Reply to its request before asking a question.");
	}
	const capability = readSteerCapability(resolved.location.asyncDir, child.index);
	if (!capability?.supported) {
		throw new Error("This child is not ready to receive questions. Continue other work until it is ready; no question was queued.");
	}
	const incarnation: SupervisorChildIncarnation = { pid: capability.pid, readyAt: capability.readyAt };
	const question: SupervisorQuestion = createSupervisorQuestion({
		channelDir,
		reason,
		message,
		runId: status.runId,
		childIndex: child.index,
		childId: child.childId,
		parentSessionId: sessionId,
		parentGeneration: input.state.sessionGeneration ?? 0,
		childIncarnation: incarnation,
	});
	try {
		if (hasBlockingSupervisorRequest(channelDir, status.runId, child.index)) {
			throw new Error("Child is waiting for a supervisor reply. Reply to its request before asking a question.");
		}
		requestAsyncSteer(resolved.location.asyncDir, {
			message: formatParentQuestionForChild(question),
			targetIndex: child.index,
			source: "supervisor-question",
			id: question.id,
		});
	} catch (error) {
		cancelSupervisorQuestion(channelDir, question.id, "failed to queue delivery to child");
		throw error instanceof Error ? error : new Error(String(error));
	}
	return {
		content: [{ type: "text", text: `Question ${question.id} queued for async run ${status.runId} child ${child.index}. The child's answer is delivered separately from the run result.` }],
		details: {
			questionId: question.id,
			state: "pending",
			runId: status.runId,
			childIndex: child.index,
			childId: child.childId,
			delivered: false,
			answered: false,
		},
	};
}
