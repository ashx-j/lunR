import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import type { EventBus } from "../../core/event-bus.ts";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	registerApprovalHandler,
	registerHostedToolGate,
	setPermissionMode,
} from "../../core/permissions.ts";
import { getSubagentCancellation } from "../../core/subagent-cancellation.ts";
import { HOST_PROTOCOL_VERSION, type HostInitialize, type HostPolicy, hostOutput } from "./hosted.ts";

// Deliberately conservative: unknown and parameter-dependent tools require a decision.
const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"fetch_content",
	"get_search_content",
	"sourcegraph",
	"repo_map",
	"symbol_outline",
	"read_block",
	"code_overview",
	"ast_search",
	"lsp_diagnostics",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_symbols",
	"lsp_completions",
	"memory_load",
	"subagent_wait",
	"present_plan",
	"structured_output",
]);

function publicChildData(source: Record<string, unknown>): Record<string, unknown> {
	const fields = [
		"id",
		"runId",
		"sessionId",
		"description",
		"agent",
		"agents",
		"task",
		"mode",
		"state",
		"status",
		"output",
		"summary",
		"success",
		"error",
		"model",
		"tier",
		"elapsedMs",
		"startedAt",
		"updatedAt",
		"index",
	];
	const data = Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
	if (source.usage && typeof source.usage === "object")
		data.usage = Object.fromEntries(
			Object.entries(source.usage).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
		);
	if (source.partialUsage && typeof source.partialUsage === "object")
		data.partialUsage = Object.fromEntries(
			Object.entries(source.partialUsage).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
		);
	if (Array.isArray(source.results))
		data.results = source.results.filter((item) => item && typeof item === "object").map(publicChildData);
	return data;
}

export class HostedSession {
	private policy: HostPolicy;
	private executionPolicy: HostPolicy;
	private turnId: string | undefined;
	private readonly pending = new Map<
		string,
		{ request: ApprovalRequest; resolve: (response: ApprovalResponse) => void }
	>();
	private readonly resolved = new Set<string>();
	private readonly approvals = new Set<string>();
	private readonly children = new Map<string, unknown>();
	private readonly cleanup: (() => void)[] = [];
	private readonly events?: EventBus;
	private readonly init: HostInitialize;
	private readonly session: AgentSession;
	constructor(init: HostInitialize, session: AgentSession, events?: EventBus) {
		this.events = events;
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "host-child") {
				const child = entry.data as { runId: string };
				if (child?.runId) this.children.set(child.runId, child);
			}
		}
		for (const name of [
			"subagent:async-started",
			"subagent:progress",
			"subagent:async-complete",
			"subagent:foreground-complete",
			"subagent:control-event",
			"subagent:steering-notice",
		]) {
			if (events)
				this.cleanup.push(
					events.on(name, (value) => {
						if (!value || typeof value !== "object") return;
						const source = value as Record<string, unknown>;
						// Internal routing tokens and filesystem control channels never cross the host protocol.
						const data = publicChildData(source);
						if (data.sessionId && data.sessionId !== session.sessionId && data.sessionId !== session.sessionFile)
							return;
						const runId = String(data.runId ?? data.id ?? "");
						if (runId) {
							const child = { name, ...data, runId };
							this.children.set(runId, child);
							session.sessionManager.appendCustomEntry("host-child", child);
						}
						hostOutput({ type: "host_child_event", name, runId, data });
					}),
				);
		}
		this.init = init;
		this.session = session;
		this.policy = init.policy!;
		this.executionPolicy = init.policy === "read-only" ? "approval-required" : init.policy!;
		this.applyPolicy();
		registerApprovalHandler((request) => this.requestApproval(request));
		registerHostedToolGate(async (toolName, input) => {
			if (READ_TOOLS.has(toolName)) return undefined;
			if (toolName === "subagent" && this.policy === "read-only" && input && typeof input === "object") {
				const args = input as {
					permissions?: string;
					action?: string;
					tasks?: Array<{ permissions?: string }>;
					chain?: Array<{ permissions?: string }>;
				};
				const children = args.tasks ?? args.chain ?? [args];
				if (!args.action && children.length > 0 && children.every((child) => child.permissions === "read-only"))
					return undefined;
			}
			if (this.policy === "read-only") return { block: true, reason: `Host read-only policy blocks ${toolName}` };
			if (this.policy === "full-access") return undefined;
			const action = JSON.stringify([toolName, input]);
			if (this.approvals.has(action)) return undefined;
			const response = await this.requestApproval({ toolName, action, detail: JSON.stringify(input) });
			const decision = typeof response === "string" ? response : response.decision;
			if (decision === "session") this.approvals.add(action);
			if (decision === "reject")
				return {
					block: true,
					reason: typeof response === "string" ? "Rejected by host" : (response.feedback ?? "Rejected by host"),
				};
			return undefined;
		});
	}
	private applyPolicy(): void {
		setPermissionMode(this.policy === "read-only" ? "read-only" : "yolo", this.session.sessionId);
	}
	private requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
		const requestId = randomUUID();
		return new Promise((resolve) => {
			this.pending.set(requestId, { request, resolve });
			hostOutput({
				type: "host_approval_request",
				requestId,
				sessionId: this.session.sessionId,
				turnId: this.turnId,
				...request,
				choices: ["once", "session", "reject"],
			});
		});
	}
	snapshot() {
		return {
			protocolVersion: HOST_PROTOCOL_VERSION,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			leafId: this.session.sessionManager.getLeafId(),
			context: this.session.getContextUsage(),
			stats: this.session.getSessionStats(),
			policy: this.policy,
			turnId: this.turnId,
			children: [...this.children.values()],
			pendingRequests: [...this.pending].map(([requestId, value]) => ({ requestId, ...value.request })),
			boundaries: this.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "host-turn"),
			isStreaming: this.session.isStreaming,
		};
	}
	ready(): void {
		hostOutput({
			type: "response",
			id: this.init.id,
			command: "host_initialize",
			success: true,
			data: this.snapshot(),
		});
	}
	beginTurn(turnId: string): void {
		if (this.session.isStreaming || this.turnId) throw new Error("Hosted turn already active");
		if (
			!turnId ||
			this.snapshot().boundaries.some((entry) => (entry as { data?: { turnId?: string } }).data?.turnId === turnId)
		)
			throw new Error("Turn already recorded; reconcile history instead of replaying it");
		this.turnId = turnId;
		this.session.sessionManager.appendCustomEntry("host-turn", {
			turnId,
			phase: "submitted",
			boundary: this.session.sessionManager.getLeafId(),
		});
	}
	rejectTurn(): void {
		this.session.sessionManager.appendCustomEntry("host-turn", { turnId: this.turnId, phase: "rejected" });
		this.turnId = undefined;
	}
	promptFinished(turnId: string, error?: string): void {
		if (this.turnId !== turnId) return;
		if (error) hostOutput({ type: "host_turn_error", turnId, message: error });
		// Extension commands and handled input can finish without ever starting an agent loop.
		if (!this.session.isStreaming) this.event({ type: "agent_settled" });
	}

	event(event: { type: string }): void {
		if (event.type === "message_end" || event.type === "auto_compaction_end" || event.type === "agent_settled") {
			hostOutput({
				type: "host_usage",
				context: this.session.getContextUsage(),
				stats: this.session.getSessionStats(),
			});
		}
		if (event.type === "agent_start" && !this.turnId) {
			this.turnId = `autonomous:${randomUUID()}`;
			this.session.sessionManager.appendCustomEntry("host-turn", { turnId: this.turnId, phase: "autonomous" });
			hostOutput({ type: "host_turn_started", turnId: this.turnId, autonomous: true });
		}
		if (event.type === "agent_settled") {
			this.session.sessionManager.appendCustomEntry("host-turn", { turnId: this.turnId, phase: "settled" });
			hostOutput({ type: "host_turn_settled", ...this.snapshot() });
			this.turnId = undefined;
		}
	}
	cancelRequests(): void {
		for (const [requestId, pending] of this.pending) {
			pending.resolve("reject");
			hostOutput({ type: "host_request_resolved", requestId, status: "cancelled" });
		}
		this.pending.clear();
	}
	async stopChildren(): Promise<void> {
		const cancellation = getSubagentCancellation(this.session.sessionFile ?? this.session.sessionId);
		if (!cancellation) return;
		const deadline = Date.now() + 5000;
		do {
			const result = await cancellation.stop();
			if (result.failed === 0) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		} while (Date.now() < deadline);
		throw new Error("Some owned children could not be stopped; they may still be running");
	}
	async command(command: Record<string, unknown>): Promise<unknown> {
		switch (command.type) {
			case "host_state":
				return this.snapshot();
			case "host_child_control": {
				if (!this.events || !["status", "stop", "interrupt", "steer"].includes(String(command.method)))
					throw new Error("Unsupported child control");
				if (!this.children.has(String(command.runId)))
					throw new Error("Child does not belong to this hosted session");
				if (command.method === "stop") {
					const cancellation = getSubagentCancellation(this.session.sessionFile ?? this.session.sessionId);
					if (!cancellation) throw new Error("Child cancellation unavailable");
					// The async-started event precedes the runner writing status.json.
					// Stop is idempotent; allow that owned launch to finish registering.
					const deadline = Date.now() + 5000;
					do {
						const result = await cancellation.stop(String(command.runId));
						if (result.failed === 0) return result;
						await new Promise((resolve) => setTimeout(resolve, 50));
					} while (Date.now() < deadline);
					throw new Error("Owned child could not be stopped; it may still be running");
				}
				const requestId = randomUUID();
				return new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						off();
						reject(new Error("Child control timed out"));
					}, 10000);
					const off = this.events!.on(`subagents:rpc:v1:reply:${requestId}`, (value) => {
						clearTimeout(timeout);
						off();
						const reply = value as { success?: boolean; data?: unknown; error?: { message?: string } };
						if (reply.success) resolve(reply.data);
						else reject(new Error(reply.error?.message ?? "Child control failed"));
					});
					this.events!.emit("subagents:rpc:v1:request", {
						version: 1,
						requestId,
						method: command.method,
						params: { runId: command.runId, message: command.message, index: command.index },
					});
				});
			}
			case "host_set_policy": {
				if (this.session.isStreaming || this.pending.size) throw new Error("Cannot change policy during a turn");
				if (!["approval-required", "full-access", "read-only"].includes(String(command.policy)))
					throw new Error("Unsupported hosted policy");
				if (command.policy !== "read-only") this.executionPolicy = command.policy as HostPolicy;
				this.policy = command.policy as HostPolicy;
				this.approvals.clear();
				this.applyPolicy();
				return this.snapshot();
			}
			case "host_approval_response": {
				const requestId = String(command.requestId);
				if (this.resolved.has(requestId)) return { resolved: true };
				const pending = this.pending.get(requestId);
				if (!pending) throw new Error("Approval expired or belongs to another worker");
				if (!["once", "session", "reject"].includes(String(command.decision)))
					throw new Error("Invalid approval decision");
				this.pending.delete(requestId);
				this.resolved.add(requestId);
				if (pending.request.kind === "plan" && command.decision !== "reject") {
					this.policy = this.executionPolicy;
					this.applyPolicy();
				}
				pending.resolve(
					command.decision === "reject" && typeof command.reason === "string"
						? { decision: "reject", feedback: command.reason }
						: (command.decision as ApprovalResponse),
				);
				hostOutput({ type: "host_request_resolved", requestId, status: "resolved" });
				return { resolved: true };
			}
			default:
				throw new Error(`Unknown hosted command: ${command.type}`);
		}
	}
	dispose(): void {
		for (const off of this.cleanup) off();
		this.cancelRequests();
		registerHostedToolGate(undefined);
		registerApprovalHandler(undefined);
	}
}
