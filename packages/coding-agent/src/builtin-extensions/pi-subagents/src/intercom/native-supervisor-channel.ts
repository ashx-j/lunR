// @ts-nocheck
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	SUBAGENT_SUPERVISOR_SESSION_ID_ENV,
} from "../runs/shared/pi-args.ts";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, POLL_INTERVAL_MS, SUBAGENT_CONTROL_EVENT, type IntercomEventBus, type SubagentState } from "../shared/types.ts";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { askRunningAsyncChild, reconcileAsyncQuestion } from "./supervisor-ask.ts";
import { CHILD_DESCRIPTION_ENV, SUPERVISOR_PROGRESS_TYPE, SUPERVISOR_PROTOCOL_VERSION, SUPERVISOR_REQUEST_TYPE, legacySupervisorBody, readCommunication, resolveCommunicationPeer, supervisorProtocolAvailable, type SubagentCommunication } from "./communication.ts";
import { renderCommunicationCall, renderCommunicationCard, renderCommunicationResult } from "../tui/communication.ts";
import { stopRequestPath } from "../runs/background/control-channel.ts";
import { readStatus } from "../shared/utils.ts";
import {
	answerSupervisorQuestion,
	cancelPendingSupervisorQuestionsForOwner,
	cancelSupervisorQuestion,
	claimQuestionNotification,
	formatSupervisorQuestionAnswer,
	hasOutstandingQuestionForChild,
	isQuestionWaitActive,
	listSupervisorChannelDirs,
	listSupervisorQuestions,
	markSupervisorQuestionDelivered,
	outstandingQuestionsForChild,
	pendingSupervisorQuestionsForDelivery,
	QUESTIONS_DIR,
	readSupervisorQuestion,
	resolveSupervisorChannelDir as resolveQuestionChannelDir,
	SUBAGENT_QUESTION_EVENT,
	SUBAGENT_SUPERVISOR_ANSWER_TYPE,
	SUPERVISOR_CHANNEL_ROOT,
	supervisorQuestionIsTerminal,
	supervisorQuestionPublicState,
	type SupervisorQuestion,
	type SupervisorQuestionOwner,
} from "./supervisor-questions.ts";

const REQUESTS_DIR = "requests";
const REPLIES_DIR = "replies";
export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
export const resolveSupervisorChannelDir = resolveQuestionChannelDir;
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
const STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1000;
const STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1000;

type SupervisorReason = "need_decision" | "interview_request" | "progress_update" | "handoff";

interface SupervisorRequest {
	type: "subagent.supervisor.request";
	protocolVersion?: number;
	description?: string;
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	supervisorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
	interview?: unknown;
}

interface PendingSupervisorRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

interface SupervisorReply {
	type: "subagent.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

interface ContactSupervisorParams {
	reason?: SupervisorReason;
	message?: string;
	interview?: unknown;
	action?: "reply";
	replyTo?: string;
}

interface IntercomParams {
	action: "list" | "send" | "ask" | "reply" | "pending" | "status";
	to?: string;
	message?: string;
	replyTo?: string;
	id?: string;
	index?: number;
	childId?: string;
	reason?: string;
}

const PARENT_ASK_DESCRIPTION = [
	"Ask a specific running async child, or reply to a child supervisor request.",
	"Ask only when the child owns missing context, the answer changes a concrete next decision, and waiting risks a block or rework.",
	"Use available results first, batch related questions, and keep working while awaiting the answer. Do not use ask for status checks, polling, duplicate queries, or step-by-step supervision. Follow up only when the answer leaves the original decision unresolved.",
	"Returns a question id immediately. The child's explicit answer is delivered separately from the final run result.",
	'Ask: { action: "ask", id: "<runId>", index?: 0, childId?: "...", reason: "<concrete decision>", message: "..." }',
	"Use pending or list to find child requests awaiting your reply; status reports channel availability. Free-form send is unsupported. Asking never revives a child or changes its assignment.",
	'Reply: { action: "reply", replyTo: "<requestId>", message: "..." }',
].join(" ");

const CHILD_CONTACT_DESCRIPTION = [
	"Contact the supervisor for decisions outside your assigned authority, safety concerns, or blockers. Make reversible implementation choices within your scope yourself.",
	"need_decision/interview_request wait for a reply: state the blocked decision, evidence, and recommended choice. Consolidate related questions; continue independent work before opening a blocking request.",
	"Return one self-contained final report with outcomes, verification, blockers, and artifact paths; the runtime delivers it. Routine work already appears in activity indicators.",
	"For parent questions use action='reply' with replyTo set to the question id. Answer from current findings and uncertainty; do not start extra investigation just to reply. Continue the assigned task after replying.",
	"Do not open a blocking need_decision while a parent question is already outstanding for this child.",
].join(" ");

const ContactSupervisorParamsSchema = Type.Object({
	reason: Type.Optional(Type.String({ enum: ["need_decision", "interview_request", "progress_update", "handoff"] })),
	message: Type.Optional(Type.String()),
	interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
	action: Type.Optional(Type.String({ enum: ["reply"] })),
	replyTo: Type.Optional(Type.String()),
}, { additionalProperties: false });

const IntercomParamsSchema = Type.Object({
	action: Type.String({ enum: ["list", "send", "ask", "reply", "pending", "status"] }),
	to: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
	id: Type.Optional(Type.String({ description: "Async run id for action='ask'." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for action='ask'. Select index or childId when more than one child is running." })),
	childId: Type.Optional(Type.String({ description: "Private child identity for action='ask'." })),
	reason: Type.Optional(Type.String({ description: "Concrete decision the child's answer will change. Required for action='ask'." })),
}, { additionalProperties: false });

const ParentSupervisorParamsSchema = Type.Object({
	...IntercomParamsSchema.properties,
	action: Type.String({ enum: ["list", "ask", "reply", "pending", "status"] }),
}, { additionalProperties: false });

function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function ensureSupervisorChannelDir(channelDir: string): void {
	fs.mkdirSync(path.join(channelDir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, REPLIES_DIR), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, QUESTIONS_DIR), { recursive: true, mode: 0o700 });
}

function requestPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

function replyPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REPLIES_DIR, `${safeSegment(requestId)}.json`);
}

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function readChildMetadata(): {
	description?: string;
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	childTarget?: string;
	supervisorSessionId?: string;
} | undefined {
	const channelDir = readTextEnv(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	if (!channelDir || !runId || !agent || !orchestratorSessionId || rawIndex === undefined || !/^\d+$/.test(rawIndex)) return undefined;
	return {
		channelDir,
		runId,
		agent,
		childIndex: Number(rawIndex),
		orchestratorTarget: readTextEnv(SUBAGENT_ORCHESTRATOR_TARGET_ENV),
		orchestratorSessionId,
		supervisorSessionId: readTextEnv(SUBAGENT_SUPERVISOR_SESSION_ID_ENV),
		childTarget: readTextEnv("PI_SUBAGENT_INTERCOM_SESSION_NAME"),
		description: readTextEnv(CHILD_DESCRIPTION_ENV),
	};
}

function readChildQuestionOwner(metadata = readChildMetadata()): SupervisorQuestionOwner | undefined {
	if (!metadata) return undefined;
	const readyAt = Number(process.env.PI_SUBAGENT_STEER_READY_AT);
	if (!Number.isFinite(readyAt) || readyAt <= 0) return undefined;
	return {
		runId: metadata.runId,
		childIndex: metadata.childIndex,
		childId: metadata.agent,
		pid: process.pid,
		readyAt,
	};
}

function answerParentQuestion(params: ContactSupervisorParams): AgentToolResult<Record<string, unknown>> {
	const metadata = readChildMetadata();
	const owner = readChildQuestionOwner(metadata);
	if (!metadata || !owner) throw new Error("Native supervisor channel is not available for this subagent.");
	const replyTo = params.replyTo?.trim();
	if (!replyTo) throw new Error("action='reply' requires replyTo with the parent question id.");
	const message = params.message?.trim();
	if (!message) throw new Error("message is required for supervisor question replies.");
	const question = readSupervisorQuestion(metadata.channelDir, replyTo);
	if (question?.parentSessionId !== (metadata.supervisorSessionId ?? metadata.orchestratorSessionId)) throw new Error("Question belongs to a different supervisor session.");
	const answered = answerSupervisorQuestion(metadata.channelDir, replyTo, message, owner);
	return {
		content: [{ type: "text", text: `Replied to parent question ${answered.id}. Continue the assigned task.` }],
		details: {
			replyTo: answered.id,
			state: supervisorQuestionPublicState(answered),
			answered: true,
			communication: { direction: "to", peer: "Supervisor", kind: "reply", message },
		},
	};
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "handoff") return "Subagent dependency handoff.";
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(input: {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
}): string {
	const lines = [
		reasonHeading(input.reason),
		`Run: ${input.runId}`,
		`Agent: ${input.agent}`,
		`Child index: ${input.childIndex}`,
	];
	if (input.childTarget) lines.push(`Child intercom target: ${input.childTarget}`);
	lines.push("");
	if (input.message?.trim()) lines.push(input.message.trim());
	if (input.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (input.interview !== undefined) lines.push(JSON.stringify(input.interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function communicationKind(reason?: SupervisorReason): SubagentCommunication["kind"] {
	return reason === "progress_update" ? "progress" : reason === "handoff" ? "handoff" : reason === "interview_request" ? "interview" : "request";
}

function communicationBody(message: string, interview?: unknown, protocolVersion?: number): string {
	const body = protocolVersion === SUPERVISOR_PROTOCOL_VERSION ? message : legacySupervisorBody(message);
	return interview !== undefined && protocolVersion === SUPERVISOR_PROTOCOL_VERSION ? `${body}\n\n${JSON.stringify(interview, null, 2)}` : body;
}

function requestCommunication(request: SupervisorRequest, state: SubagentState): SubagentCommunication {
	return {
		direction: "from",
		peer: resolveCommunicationPeer(state, request.runId, request.childIndex, request.agent, request.description),
		message: communicationBody(request.message, request.interview, request.protocolVersion),
		kind: communicationKind(request.reason),
	};
}

export function registerSupervisorRenderers(pi: ExtensionAPI, state: SubagentState): void {
	for (const customType of [SUPERVISOR_REQUEST_TYPE, SUBAGENT_SUPERVISOR_ANSWER_TYPE]) {
		pi.registerMessageRenderer(customType, (message, options, theme) => {
			const details = message.details as { communication?: unknown; runId?: string; childIndex?: number; agent?: string; childId?: string; reason?: SupervisorReason } | undefined;
			const communication = readCommunication(details?.communication) ?? {
				direction: "from" as const,
				peer: details?.runId ? resolveCommunicationPeer(state, details.runId, details.childIndex ?? 0, details.childId ?? details.agent) : "Subagent",
				message: legacySupervisorBody(typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")),
				kind: customType === SUBAGENT_SUPERVISOR_ANSWER_TYPE ? "answer" as const : communicationKind(details?.reason),
			};
			return renderCommunicationCard(communication, options.expanded, theme);
		});
	}
	pi.registerEntryRenderer(SUPERVISOR_PROGRESS_TYPE, (entry, options, theme) => {
		const communication = readCommunication((entry.data as { communication?: unknown } | undefined)?.communication);
		return communication ? renderCommunicationCard(communication, options.expanded, theme) : undefined;
	});
}

function parseStructuredReply(message: string): { value?: unknown; error?: string } {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDir: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<SupervisorReply> {
	const file = replyPath(channelDir, requestId);
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
			if (parsed.type === "subagent.supervisor.reply" && parsed.requestId === requestId && typeof parsed.message === "string") {
				return parsed as SupervisorReply;
			}
		}
		await delay(250, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

async function sendSupervisorRequest(params: ContactSupervisorParams, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	if (params.action === "reply" || params.replyTo?.trim()) {
		return answerParentQuestion(params);
	}
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Native supervisor channel is not available for this subagent.");
	if (!params.reason) throw new Error("reason is required for supervisor contact.");
	if (signal?.aborted) throw new Error("Supervisor request cancelled.");
	const protocolVersion = supervisorProtocolAvailable() ? SUPERVISOR_PROTOCOL_VERSION : undefined;
	if (params.reason === "handoff" && !protocolVersion) throw new Error("This supervisor uses the legacy protocol. Send actionable findings with progress_update instead.");
	const expectsReply = params.reason === "need_decision" || params.reason === "interview_request";
	if (expectsReply && hasOutstandingQuestionForChild(metadata.channelDir, metadata.childIndex, metadata.agent)) {
		throw new Error("A parent question is already outstanding for this child. Answer it with action='reply' before opening a blocking supervisor request.");
	}
	if (!params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor contact.");
	}
	ensureSupervisorChannelDir(metadata.channelDir);
	const requestId = randomUUID();
	const createdAt = Date.now();
	const replyDeadline = createdAt + askTimeoutMs();
	const expiresAt = expectsReply ? replyDeadline : undefined;
	const message = protocolVersion ? params.message?.trim() || "Structured supervisor input requested." : formatChildMessage({ ...metadata, reason: params.reason, message: params.message, interview: params.interview });
	const communication: SubagentCommunication = { direction: "to", peer: "Supervisor", kind: communicationKind(params.reason), message: communicationBody(message, params.interview, protocolVersion) };
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		...(protocolVersion ? { protocolVersion } : {}),
		...(metadata.description ? { description: metadata.description } : {}),
		id: requestId,
		createdAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		reason: params.reason,
		message,
		expectsReply,
		...(metadata.orchestratorTarget ? { orchestratorTarget: metadata.orchestratorTarget } : {}),
		...(metadata.orchestratorSessionId ? { orchestratorSessionId: metadata.orchestratorSessionId } : {}),
		...(metadata.supervisorSessionId ? { supervisorSessionId: metadata.supervisorSessionId } : {}),
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		...(metadata.childTarget ? { childTarget: metadata.childTarget } : {}),
		...(params.interview !== undefined ? { interview: params.interview } : {}),
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);
	if (expectsReply) {
		for (const question of outstandingQuestionsForChild(metadata.channelDir, metadata.childIndex, metadata.agent)) {
			cancelSupervisorQuestion(metadata.channelDir, question.id, "child needs a supervisor decision; reply to its request first");
		}
	}

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: params.reason === "handoff" ? "Dependency handoff queued. Continue independent work." : protocolVersion ? "Progress recorded for the UI only; the supervisor model will not receive it." : "Supervisor progress update queued." }],
			details: { queued: true, requestId, reason: params.reason, communication },
		};
	}

	try {
		const reply = await waitForReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason, communication, response: reply.message };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply.message);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		removeRequestFile(requestPath(metadata.channelDir, requestId));
		throw error;
	}
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

export function registerNativeSupervisorClient(pi: ExtensionAPI, options: { includeIntercomFallback?: boolean } = {}): void {
	if (!readChildMetadata()) return;
	const includeIntercomFallback = options.includeIntercomFallback !== false;
	if (!hasTool(pi, "contact_supervisor")) {
		const tool: ToolDefinition<typeof ContactSupervisorParamsSchema, Record<string, unknown>> = {
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: `${CHILD_CONTACT_DESCRIPTION} ${supervisorProtocolAvailable()
				? "handoff delivers actionable dependency findings or corrections without waiting: state what changes and consolidate evidence or reference one artifact. progress_update is UI-only and never reaches the supervisor model."
				: "This legacy supervisor delivers progress_update to its model. Reserve it for actionable dependency findings or corrections."}`,
			parameters: supervisorProtocolAvailable() ? ContactSupervisorParamsSchema : Type.Object({ ...ContactSupervisorParamsSchema.properties, reason: Type.Optional(Type.String({ enum: ["need_decision", "interview_request", "progress_update"] })) }, { additionalProperties: false }),
			renderCall(args, theme, context) {
				return renderCommunicationCall("contact_supervisor", args, theme, context, { direction: "to", peer: "Supervisor", kind: args.action === "reply" ? "reply" : communicationKind(args.reason), message: communicationBody(args.message ?? "", args.interview, SUPERVISOR_PROTOCOL_VERSION) });
			},
			renderResult(result, options, theme, context) {
				return renderCommunicationResult(result.content, result.details, options.expanded, context.isError, theme);
			},
			execute(_id, params, signal) {
				return sendSupervisorRequest(params as ContactSupervisorParams, signal);
			},
		};
		pi.registerTool(tool);
	}
	if (includeIntercomFallback && !hasTool(pi, "intercom")) {
		const tool: ToolDefinition<typeof IntercomParamsSchema, Record<string, unknown>> = {
			name: "intercom",
			label: "Intercom",
			description: "Supervisor-only fallback; sibling discovery and sibling messaging are unavailable. Use contact_supervisor for decisions, replies, and dependency handoffs. list reports no sibling sessions; ask blocks for a supervisor decision; send is progress only.",
			parameters: IntercomParamsSchema,
			renderCall(args, theme, context) {
				return renderCommunicationCall("intercom", args, theme, context, args.message ? { direction: "to", peer: "Supervisor", kind: args.action === "ask" ? "request" : "progress", message: args.message } : undefined);
			},
			renderResult(result, options, theme, context) {
				return renderCommunicationResult(result.content, result.details, options.expanded, context.isError, theme);
			},
			async execute(_id, params, signal) {
				const action = (params as IntercomParams).action;
				if (action === "status") return { content: [{ type: "text", text: "Native supervisor channel is active." }], details: { active: true } };
				if (action === "list") return { content: [{ type: "text", text: "Supervisor session available through contact_supervisor." }], details: { sessions: [] } };
				if (action === "send") return sendSupervisorRequest({ reason: "progress_update", message: (params as IntercomParams).message ?? "" }, signal);
				if (action === "ask") return sendSupervisorRequest({ reason: "need_decision", message: (params as IntercomParams).message ?? "" }, signal);
				throw new Error("Native child intercom supports status, list, send, and ask. Use parent intercom reply from the supervisor session.");
			},
		};
		pi.registerTool(tool);
	}
}

function parseRequestFile(file: string, channelDir: string): PendingSupervisorRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "subagent.supervisor.request") return undefined;
		if (parsed.supervisorSessionId !== undefined && (typeof parsed.supervisorSessionId !== "string" || !parsed.supervisorSessionId.trim())) return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update" && parsed.reason !== "handoff") return undefined;
		if (parsed.protocolVersion !== undefined && parsed.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) return undefined;
		if (parsed.protocolVersion === SUPERVISOR_PROTOCOL_VERSION && parsed.expectsReply !== (parsed.reason === "need_decision" || parsed.reason === "interview_request")) return undefined;
		if (parsed.reason === "handoff" && parsed.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) return undefined;
		if (parsed.description !== undefined && typeof parsed.description !== "string") return undefined;
		if (typeof parsed.message !== "string" || !parsed.message) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
		return { ...parsed as SupervisorRequest, channelDir, requestFile: file };
	} catch {
		return undefined;
	}
}

export function hasPendingBlockingSupervisorRequest(runId: string, sessionId?: string | null, now = Date.now()): boolean {
	if (!runId) return false;
	for (const { channelDir, file } of listRequestFiles()) {
		const request = parseRequestFile(file, channelDir);
		if (!request?.expectsReply) continue;
		if (request.runId !== runId) continue;
		if (sessionId && (request.supervisorSessionId ?? request.orchestratorSessionId) !== sessionId) continue;
		if (fs.existsSync(replyPath(request.channelDir, request.id))) continue;
		if (now > requestExpiresAt(request, now)) continue;
		return true;
	}
	return false;
}

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json")) files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
		}
	}
	return files;
}

function readDirectoryEntries(dir: string): fs.Dirent[] | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
}

function directoryMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function removeEmptyDirectory(dir: string): boolean {
	try {
		fs.rmdirSync(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
		throw error;
	}
}

function removeStaleEmptySupervisorChannel(channelDir: string, nowMs: number): boolean {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const repliesDir = path.join(channelDir, REPLIES_DIR);
	const questionsPath = path.join(channelDir, QUESTIONS_DIR);
	const newestKnownMtimeMs = Math.max(
		directoryMtimeMs(channelDir),
		directoryMtimeMs(requestsDir),
		directoryMtimeMs(repliesDir),
		directoryMtimeMs(questionsPath),
	);
	if (nowMs - newestKnownMtimeMs < STALE_EMPTY_CHANNEL_AGE_MS) return false;

	const requestEntries = readDirectoryEntries(requestsDir);
	if (!requestEntries || requestEntries.length > 0) return false;
	const replyEntries = readDirectoryEntries(repliesDir);
	if (!replyEntries || replyEntries.length > 0) return false;
	const questionEntries = readDirectoryEntries(questionsPath);
	if (!questionEntries || questionEntries.length > 0) return false;

	if (!removeEmptyDirectory(requestsDir)) return false;
	if (!removeEmptyDirectory(repliesDir)) return false;
	if (!removeEmptyDirectory(questionsPath)) return false;
	if (!removeEmptyDirectory(channelDir)) return false;
	return true;
}

function cleanupStaleEmptySupervisorChannels(nowMs = Date.now()): number {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let removed = 0;
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		try {
			if (removeStaleEmptySupervisorChannel(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs)) removed++;
		} catch {
			// Cleanup is opportunistic; active writers can race with us and will be picked up by a later pass.
		}
	}
	return removed;
}

function currentContextSessionId(state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): string | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return sessionId;
	} catch {
		// Fall through to the last known identity.
	}
	return state.currentSessionId ?? undefined;
}

function currentSupervisorSessionId(state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile?.() ?? currentContextSessionId(state, ctx);
	} catch {
		return state.currentSessionId ?? undefined;
	}
}

function requestMatchesContext(request: SupervisorRequest, state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): boolean {
	const currentSessionId = request.supervisorSessionId !== undefined
		? currentSupervisorSessionId(state, ctx)
		: currentContextSessionId(state, ctx);
	return Boolean(currentSessionId && (request.supervisorSessionId ?? request.orchestratorSessionId) === currentSessionId);
}

function removeRequestFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Request cleanup is best-effort; reply files and timeout errors remain authoritative.
	}
}

type SupervisorRequestLifecycle = "pending" | "resolved" | "expired" | "inactive" | "missing" | "wrong-session";

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + askTimeoutMs() : now;
}

function requestRunState(request: SupervisorRequest, state: SubagentState): "active" | "inactive" | "stopped" {
	if (state.foregroundControls.has(request.runId)) return "active";
	const foregroundRun = state.foregroundRuns?.get(request.runId);
	const foregroundChild = foregroundRun?.children.find((child) => child.index === request.childIndex && child.agent === request.agent)
		?? foregroundRun?.children[request.childIndex];
	if (foregroundChild) return foregroundChild.status === "stopped" ? "stopped" : foregroundChild.status === "detached" ? "active" : "inactive";

	const job = state.asyncJobs.get(request.runId) ?? state.fleetJobs?.get(request.runId);
	const asyncDir = job?.asyncDir ?? path.join(ASYNC_DIR, safeSegment(request.runId));
	const status = readStatus(asyncDir);
	const runStatus = status?.state ?? job?.status;
	const stepStatus = (status?.steps ?? job?.steps)?.[request.childIndex]?.status;
	if (fs.existsSync(stopRequestPath(asyncDir)) || runStatus === "stopped" || job?.status === "stopped" || status?.stopped || stepStatus === "stopped") return "stopped";
	if (["complete", "failed", "paused"].includes(runStatus ?? "") || ["complete", "completed", "failed", "paused"].includes(stepStatus ?? "")) return "inactive";
	return "active";
}

function requestLifecycle(request: PendingSupervisorRequest, state: SubagentState, ctx: ExtensionContext | undefined, now: number): SupervisorRequestLifecycle {
	if (ctx && !requestMatchesContext(request, state, ctx)) return "wrong-session";
	if (!fs.existsSync(request.requestFile)) return "missing";
	if (request.expectsReply && fs.existsSync(replyPath(request.channelDir, request.id))) return "resolved";
	if (request.expectsReply && now > requestExpiresAt(request, now)) return "expired";
	const runState = requestRunState(request, state);
	if (runState === "stopped" || (request.expectsReply && runState === "inactive")) return "inactive";
	return "pending";
}

function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "resolved" || lifecycle === "expired" || lifecycle === "inactive") removeRequestFile(request.requestFile);
}

function refreshPendingRequests(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, ctx: ExtensionContext | undefined): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, ctx, now);
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		cleanupRequestLifecycle(request, lifecycle);
	}
}

function formatPendingLine(request: PendingSupervisorRequest): string {
	const replyHint = request.expectsReply ? ` Reply: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })` : "";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.${replyHint}`;
}

function requestVisibleText(request: PendingSupervisorRequest, communication: SubagentCommunication): string {
	const lines = [`From: ${communication.peer}`, "", communication.message];
	if (request.reason === "interview_request") lines.push("", "Reply with JSON matching the requested interview shape.");
	if (request.expectsReply) {
		lines.push("", `Reply with: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })`);
	}
	return lines.join("\n");
}

function writeReply(request: PendingSupervisorRequest, message: string): void {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply: SupervisorReply = {
		type: "subagent.supervisor.reply",
		requestId: request.id,
		createdAt: Date.now(),
		message: message.trim(),
	};
	writeAtomicJson(replyPath(request.channelDir, request.id), reply);
	removeRequestFile(request.requestFile);
}

function resolvePendingRequest(pending: Map<string, PendingSupervisorRequest>, params: IntercomParams): PendingSupervisorRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		return request;
	}
	const requests = [...pending.values()].filter((request) => request.expectsReply);
	if (params.to) {
		const normalizedTo = params.to.toLowerCase();
		const matches = requests.filter((request) =>
			request.id.toLowerCase().startsWith(normalizedTo)
			|| request.agent.toLowerCase() === normalizedTo
			|| request.childTarget?.toLowerCase() === normalizedTo,
		);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Multiple pending supervisor requests match '${params.to}'. Use replyTo.`);
	}
	if (requests.length === 1) return requests[0]!;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): Array<Record<string, unknown>> {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

function buildParentIntercomTool(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, name = "intercom"): ToolDefinition<typeof ParentSupervisorParamsSchema, Record<string, unknown>> {
	return {
		name,
		label: name === "intercom" ? "Intercom" : "Subagent Supervisor",
		description: PARENT_ASK_DESCRIPTION,
		parameters: ParentSupervisorParamsSchema,
		renderCall(args, theme, context) {
			const request = args.action === "reply" ? pending.get(args.replyTo) : undefined;
			const peer = request ? requestCommunication(request, state).peer : args.id ? resolveCommunicationPeer(state, args.id, args.index ?? 0, args.childId) : "Subagent";
			return renderCommunicationCall(name, args, theme, context, args.message ? { direction: "to", peer, message: args.message, kind: args.action === "ask" ? "question" : "reply" } : undefined);
		},
		renderResult(result, options, theme, context) {
			return renderCommunicationResult(result.content, result.details, options.expanded, context.isError, theme);
		},
		async execute(_id, params) {
			refreshPendingRequests(pending, state, state.lastUiContext ?? undefined);
			const input = params as IntercomParams;
			if (input.action === "status") {
				return { content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }], details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT } };
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()].filter((request) => request.expectsReply).map(formatPendingLine);
				return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }], details: { pending: publicPendingRequests(pending) } };
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input);
				writeReply(request, input.message ?? "");
				pending.delete(request.id);
				return { content: [{ type: "text", text: `Replied to ${requestCommunication(request, state).peer}.` }], details: { replyTo: request.id, runId: request.runId, agent: request.agent, communication: { ...requestCommunication(request, state), direction: "to", kind: "reply", message: input.message } } };
			}
			if (input.action === "ask") {
				return askRunningAsyncChild({
					params: {
						id: input.id,
						index: input.index,
						childId: input.childId,
						reason: input.reason,
						message: input.message,
					},
					state,
					childRequests: pending.values(),
				});
			}
			if (input.action === "send") {
				throw new Error("Native pi-subagents intercom does not support free-form send. Use action='ask' for a running async child or action='reply' for a pending child request.");
			}
			throw new Error(`Unsupported intercom action: ${input.action}`);
		},
	};
}

function questionMatchesParentContext(question: SupervisorQuestion, state: SubagentState, ctx: ExtensionContext): boolean {
	const sessionId = currentSupervisorSessionId(state, ctx);
	if (!sessionId || question.parentSessionId !== sessionId) return false;
	if ((state.sessionGeneration ?? 0) !== question.parentGeneration) return false;
	return true;
}

function notifyQuestionTerminal(pi: ExtensionAPI, question: SupervisorQuestion, channelDir: string, state: SubagentState): void {
	if (!supervisorQuestionIsTerminal(question) || question.notifiedAt) return;
	(pi as { events?: IntercomEventBus }).events?.emit(SUBAGENT_QUESTION_EVENT, {
		questionId: question.id,
		state: supervisorQuestionPublicState(question),
		runId: question.runId,
	});
	if (isQuestionWaitActive(question.id)) return;
	if (!claimQuestionNotification(channelDir, question.id)) return;
	const outcome = supervisorQuestionPublicState(question);
	const communication: SubagentCommunication = { direction: "from", peer: question.childDescription ?? resolveCommunicationPeer(state, question.runId, question.childIndex, question.childId), message: question.answer ?? question.cancelReason ?? outcome, kind: "answer" };
	pi.sendMessage({
		customType: SUBAGENT_SUPERVISOR_ANSWER_TYPE,
		content: formatSupervisorQuestionAnswer(question),
		display: outcome === "answered",
		details: {
			questionId: question.id,
			state: outcome,
			communication,
			runId: question.runId,
			childIndex: question.childIndex,
			childId: question.childId,
			reason: question.reason,
			answered: outcome === "answered",
			delivered: Boolean(question.deliveredAt),
		},
	}, { triggerTurn: outcome === "answered" });
}

function pollSupervisorQuestions(pi: ExtensionAPI, state: SubagentState, ctx: ExtensionContext): void {
	for (const channelDir of listSupervisorChannelDirs()) {
		for (const question of listSupervisorQuestions(channelDir)) {
			if (!questionMatchesParentContext(question, state, ctx)) continue;
			const current = reconcileAsyncQuestion(channelDir, question, state);
			notifyQuestionTerminal(pi, current, channelDir, state);
		}
	}
}

export function createNativeSupervisorChannel(pi: ExtensionAPI, state: SubagentState): {
	start: () => void;
	dispose: () => void;
	pending: Map<string, PendingSupervisorRequest>;
	cancelOwnedQuestions: (reason: string) => void;
	settleRunQuestions: (runId: string, reason: string) => void;
} {
	const pending = new Map<string, PendingSupervisorRequest>();
	const seenFiles = new Set<string>();
	const deliveredRequests = new Set<string>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let lastStaleCleanupAt = 0;

	const registerParentTools = (): void => {
		if (!hasTool(pi, NATIVE_SUPERVISOR_TOOL_NAME)) pi.registerTool(buildParentIntercomTool(pending, state, NATIVE_SUPERVISOR_TOOL_NAME));
		if (!hasTool(pi, "intercom")) pi.registerTool(buildParentIntercomTool(pending, state));
	};

	const cleanupStaleChannelsIfDue = (): void => {
		const nowMs = Date.now();
		if (nowMs - lastStaleCleanupAt < STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS) return;
		lastStaleCleanupAt = nowMs;
		try {
			cleanupStaleEmptySupervisorChannels(nowMs);
		} catch {
			// Supervisor delivery must not fail because best-effort temp cleanup failed.
		}
	};

	const cancelOwnedQuestions = (reason: string): void => {
		if (!state.currentSessionId) return;
		cancelPendingSupervisorQuestionsForOwner({
			parentSessionId: state.currentSessionId,
			parentGeneration: state.sessionGeneration ?? 0,
			reason,
		});
	};

	const settleRunQuestions = (runId: string, reason: string): void => {
		if (!state.currentSessionId) return;
		cancelPendingSupervisorQuestionsForOwner({
			parentSessionId: state.currentSessionId,
			runId,
			reason,
		});
	};

	const poll = (): void => {
		cleanupStaleChannelsIfDue();
		const ctx = state.lastUiContext;
		if (!ctx) return;
		refreshPendingRequests(pending, state, ctx);
		pollSupervisorQuestions(pi, state, ctx);
		const now = Date.now();
		for (const { channelDir, file } of listRequestFiles()) {
			if (seenFiles.has(file)) continue;
			const request = parseRequestFile(file, channelDir);
			if (!request || !requestMatchesContext(request, state, ctx)) continue;
			const lifecycle = requestLifecycle(request, state, undefined, now);
			if (lifecycle !== "pending") {
				seenFiles.add(file);
				cleanupRequestLifecycle(request, lifecycle);
				continue;
			}
			if (request.expectsReply) pending.set(request.id, request);
			if (deliveredRequests.has(request.id)) {
				seenFiles.add(file);
				continue;
			}
			const communication = requestCommunication(request, state);
			const details = {
				id: request.id,
				reason: request.reason,
				expectsReply: request.expectsReply,
				runId: request.runId,
				agent: request.agent,
				childIndex: request.childIndex,
				communication,
			};
			if (request.reason === "progress_update" && request.protocolVersion === SUPERVISOR_PROTOCOL_VERSION) {
				pi.appendEntry(SUPERVISOR_PROGRESS_TYPE, details);
			} else {
				pi.sendMessage({
					customType: SUPERVISOR_REQUEST_TYPE,
					content: requestVisibleText(request, communication),
					display: true,
					details,
				}, { triggerTurn: request.expectsReply || request.reason === "handoff" });
			}
			deliveredRequests.add(request.id);
			seenFiles.add(file);
			if (!request.expectsReply) removeRequestFile(request.requestFile);
			if (request.expectsReply) {
				const job = state.asyncJobs.get(request.runId);
				if (job) job.activityState = "needs_attention";
				const events = (pi as { events?: IntercomEventBus }).events;
				events?.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: request.id,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				});
				events?.emit(SUBAGENT_CONTROL_EVENT, {
					type: "needs_attention",
					to: "needs_attention",
					runId: request.runId,
					agent: request.agent,
					index: request.childIndex,
				});
			}
		}
	};

	return {
		start: () => {
			if (poller) return;
			registerParentTools();
			for (const entry of state.lastUiContext?.sessionManager.getBranch?.() ?? []) {
				const data = entry.type === "custom_message" && entry.customType === SUPERVISOR_REQUEST_TYPE ? entry.details
					: entry.type === "custom" && entry.customType === SUPERVISOR_PROGRESS_TYPE ? entry.data : undefined;
				if (data && typeof data === "object" && "id" in data && typeof data.id === "string") deliveredRequests.add(data.id);
			}
			poll();
			poller = setInterval(poll, CHANNEL_POLL_MS);
			poller.unref?.();
		},
		dispose: () => {
			cancelOwnedQuestions("parent supervisor channel disposed");
			if (poller) clearInterval(poller);
			poller = undefined;
			pending.clear();
			seenFiles.clear();
			deliveredRequests.clear();
		},
		pending,
		cancelOwnedQuestions,
		settleRunQuestions,
	};
}

export function isPendingQuestionForCurrentChild(questionId: string): boolean {
	const metadata = readChildMetadata();
	const owner = readChildQuestionOwner(metadata);
	if (!metadata || !owner) return false;
	return pendingSupervisorQuestionsForDelivery(metadata.channelDir, owner).some((question) =>
		question.id === questionId && question.parentSessionId === (metadata.supervisorSessionId ?? metadata.orchestratorSessionId),
	);
}

export function markDeliveredSupervisorQuestionFromChild(message: string): void {
	const match = message.match(/Parent question \(([^)\s]+)\)/);
	if (!match?.[1]) return;
	const metadata = readChildMetadata();
	const owner = readChildQuestionOwner(metadata);
	if (!metadata || !owner) return;
	if (!isPendingQuestionForCurrentChild(match[1])) return;
	try {
		markSupervisorQuestionDelivered(metadata.channelDir, match[1], owner);
	} catch {
		// Delivery markers are best-effort; answer ownership still enforces identity.
	}
}
