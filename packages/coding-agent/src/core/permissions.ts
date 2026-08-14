/**
 * lunR: permission modes (Manual / YOLO / Plan / Auto).
 *
 * Per-session only — never persisted per session, but the default mode new
 * sessions start with is configurable in /settings (`defaultPermissionMode`,
 * default "manual").
 *
 * - manual: every mutating tool call (bash, edit, write) requires approval.
 * - yolo:   auto-approve tools; the agent may still ask questions.
 * - plan:   read-only; mutating tools are hard-blocked (planModeBlockReason).
 * - auto:   fully autonomous; a system-prompt addendum steers the model to
 *           self-decide, and rollback is force-enabled for the session.
 *
 * The gate is wired into `agent-session.ts` `_installAgentToolHooks` before
 * the synchronous `_toolCallGates` loop. beforeToolCall is already async, so
 * awaiting the approval dialog is fine.
 *
 * State (mode + session-scoped approvals) is keyed by session id so
 * concurrent gateway chats do not share permission decisions.
 */

import { resolve } from "node:path";
import { planModeBlockReason } from "./plan-mode.ts";
import { effectiveSwarmCount, SWARM_APPROVAL_THRESHOLD } from "./swarm.ts";

/** Shift+Tab cycle order. */
export const PERMISSION_MODES = ["manual", "yolo", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function nextPermissionMode(current: PermissionMode): PermissionMode {
	const i = PERMISSION_MODES.indexOf(current);
	return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
}

/** True when the (default or session) permission mode is plan. */
export function isPlanModeActive(sessionId?: string): boolean {
	return getPermissionMode(sessionId) === "plan";
}

/**
 * Destination mode when leaving plan via approve / `/plan off` / `/plan <text>`.
 * Explicit Shift+Tab or `/mode` picks do not use this — they already chose a mode.
 */
export function restorePermissionModeAfterPlan(
	previous: PermissionMode | undefined,
	defaultMode: PermissionMode,
): PermissionMode {
	if (previous && previous !== "plan") return previous;
	return defaultMode === "plan" ? "yolo" : defaultMode;
}

export interface ApprovalRequest {
	toolName: string;
	/** "bash" (detail = command), "edit"/"write" (detail = path),
	 *  "edit-outside"/"write-outside" when path escapes cwd,
	 *  "swarm" for auto-activated agent swarms (detail = summary lines). */
	action: string;
	detail: string;
	/** "swarm" when this is the agent-swarm approval prompt, "plan" for the
	 *  present_plan plan-approval prompt — the UI renders a dedicated dialog
	 *  for each instead of the generic tool dialog. */
	kind?: "swarm" | "plan";
}

export type ApprovalDecision = "once" | "session" | "reject";
/** Handlers may return a bare decision string, a reject carrying user feedback
 *  that becomes the block reason the model sees, or an approve carrying optional
 *  feedback (plan approval with comments). */
export type ApprovalResponse =
	| ApprovalDecision
	| { decision: "reject"; feedback: string }
	| { decision: "approve"; feedback?: string };

/** Read-only tools that never need approval. */
const READ_ONLY_TOOLS = new Set([
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
	"lsp_code_actions",
	"lsp_completions",
	"behavior_load",
	"memory_load",
]);

/** Tools that mutate state and must be gated in manual mode. */
const MUTATING_TOOLS = new Set([
	"bash",
	"edit",
	"write",
	"behavior_add",
	"behavior_remove",
	"memory_add",
	"memory_remove",
	"cron",
]);

const REJECT_REASON = "Rejected by user (permission mode: manual).";
export const NO_HANDLER_REASON = "Mutating tool blocked in manual mode: no approval channel available.";
export const SWARM_REJECT_REASON = "Agent swarm rejected by user.";
export const NO_SWARM_HANDLER_REASON = "Agent swarm blocked: no approval channel available.";
/** Session-approval key for auto-activated agent swarms. */
const SWARM_ACTION = "swarm";

interface PermissionContext {
	mode: PermissionMode;
	approvals: Set<string>;
}

const contexts = new Map<string, PermissionContext>();
let defaultContext: PermissionContext = { mode: "manual", approvals: new Set() };
let approvalHandler: ((req: ApprovalRequest) => Promise<ApprovalResponse>) | undefined;

function getContext(sessionId?: string): PermissionContext {
	if (!sessionId) return defaultContext;
	return contexts.get(sessionId) ?? defaultContext;
}

export function createPermissionContext(sessionId: string, mode: PermissionMode = defaultContext.mode): void {
	contexts.set(sessionId, { mode, approvals: new Set() });
}

export function deletePermissionContext(sessionId: string): void {
	contexts.delete(sessionId);
}

export function getPermissionMode(sessionId?: string): PermissionMode {
	return getContext(sessionId).mode;
}

export function setPermissionMode(mode: PermissionMode, sessionId?: string): void {
	getContext(sessionId).mode = mode;
}

export function resetPermissions(defaultMode: PermissionMode = "manual", sessionId?: string): void {
	if (sessionId) {
		contexts.set(sessionId, { mode: defaultMode, approvals: new Set() });
	} else {
		defaultContext = { mode: defaultMode, approvals: new Set() };
	}
}

export function registerApprovalHandler(fn: ((req: ApprovalRequest) => Promise<ApprovalResponse>) | undefined): void {
	approvalHandler = fn;
}

/** Model-facing result texts for the present_plan tool. */
export const PLAN_APPROVED_TEXT = "Plan approved — implement it now.";
export const PLAN_DECLINED_TEXT = "Plan declined — revise the plan and call present_plan again.";
export const PLAN_PASS_THROUGH_TEXT = "Plan presented. The user will review and reply.";

/** lunr: map an approval response to the model-facing present_plan result text. */
export function planApprovalResultText(resp: ApprovalResponse): string {
	const decision = typeof resp === "string" ? resp : resp.decision;
	const feedback = typeof resp === "string" ? undefined : resp.feedback?.trim();
	if (decision === "reject") {
		return feedback
			? `Plan declined: ${feedback} — revise the plan and call present_plan again.`
			: PLAN_DECLINED_TEXT;
	}
	return feedback ? `Plan approved with feedback: ${feedback} — implement it now.` : PLAN_APPROVED_TEXT;
}

/**
 * lunr: present_plan approval request. Unlike the mutating-tool and swarm gates
 * this fails OPEN when no approval handler is registered (or none is reachable,
 * e.g. a gateway turn without a chat context): headless sessions have no one to
 * show the dialog to, so the plan is presented and the user replies in chat
 * instead of deadlocking the turn. Everything else keeps fail-closed.
 */
export async function requestPlanApproval(summary: string): Promise<string> {
	if (!approvalHandler) return PLAN_PASS_THROUGH_TEXT;
	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({ toolName: "present_plan", action: "plan", detail: summary, kind: "plan" });
	} catch (err) {
		const message = err instanceof Error ? err.message : "approval request failed";
		if (message === NO_HANDLER_REASON) return PLAN_PASS_THROUGH_TEXT;
		return `Plan declined: ${message} — revise the plan and call present_plan again.`;
	}
	return planApprovalResultText(resp);
}

export function clearSessionApprovals(sessionId?: string): void {
	getContext(sessionId).approvals.clear();
}

/** Test seam: remove every per-session context and restore the default. */
export function resetAllPermissionContexts(): void {
	contexts.clear();
	defaultContext = { mode: "manual", approvals: new Set() };
	approvalHandler = undefined;
}

/** Appended to the system prompt while auto mode is active. */
export const AUTO_MODE_ADDENDUM =
	"You are running fully autonomously. Do not ask the user questions or wait for confirmation; make reasonable decisions and complete the task end-to-end.";

function isPathOutsideCwd(absPath: string, cwd: string): boolean {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "");
	const np = norm(absPath);
	const nc = norm(cwd);
	if (np === nc) return false;
	return !np.startsWith(`${nc}/`);
}

function resolvePath(cwd: string, p: unknown): string {
	if (typeof p !== "string") return "";
	if (!p) return "";
	return resolve(cwd, p);
}

function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

export interface GateOptions {
	/** True when the current turn started from an explicit /swarm prompt — the
	 *  user already asked for the swarm, so the swarm approval gate is skipped. */
	explicitSwarmTurn?: boolean;
}

/** First task text of a parallel fan-out, used as the dialog summary line. */
function swarmTaskSummary(input: Record<string, unknown>): string {
	if (!Array.isArray(input.tasks)) return "";
	for (const task of input.tasks) {
		const text = task && typeof task === "object" ? (task as { task?: unknown }).task : undefined;
		if (typeof text === "string" && text.trim()) return sanitizeDetail(text);
	}
	return "";
}

/**
 * Agent-swarm gate. An auto-activated swarm (one `subagent` call launching more
 * than SWARM_APPROVAL_THRESHOLD parallel subagents) requires user approval in
 * manual AND yolo modes; auto mode runs it unconditionally and explicit /swarm
 * turns are pre-approved. Fail-closed without an approval handler, same as the
 * mutating-tool gate.
 */
async function gateSwarmCall(
	input: Record<string, unknown>,
	ctx: PermissionContext,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	if (ctx.mode === "auto") return undefined;
	if (options?.explicitSwarmTurn) return undefined;
	const count = effectiveSwarmCount(input);
	if (count <= SWARM_APPROVAL_THRESHOLD) return undefined;
	if (ctx.approvals.has(SWARM_ACTION)) return undefined;

	if (!approvalHandler) {
		return { block: true, reason: NO_SWARM_HANDLER_REASON };
	}

	const summary = swarmTaskSummary(input);
	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({
			toolName: "subagent",
			action: SWARM_ACTION,
			detail: summary ? `agent swarm (${count} subagents)\n${summary}` : `agent swarm (${count} subagents)`,
			kind: "swarm",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : NO_SWARM_HANDLER_REASON;
		return { block: true, reason: message };
	}

	const decision = typeof resp === "string" ? resp : resp.decision;
	if (decision === "session") {
		ctx.approvals.add(SWARM_ACTION);
		return undefined;
	}
	if (decision === "reject") {
		const feedback = typeof resp === "string" ? undefined : resp.feedback?.trim();
		return { block: true, reason: feedback ? `${SWARM_REJECT_REASON} ${feedback}` : SWARM_REJECT_REASON };
	}
	return undefined;
}

function sanitizeDetail(value: unknown): string {
	const text = String(value ?? "").trim();
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Returns a block result when the tool call should be blocked, else undefined.
 * Read-only tools always pass. YOLO and Auto always pass mutating tools. Plan
 * mode hard-blocks mutating tools (no prompt). Manual mode gates every mutating
 * tool; if an approval handler is registered it is asked, otherwise the call is
 * blocked (fail-closed — no silent allow).
 */
export async function gateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	sessionId?: string,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	const ctx = getContext(sessionId);
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;

	// lunr: agent-swarm gate runs before the mode early-return — it applies in
	// yolo mode too (only auto mode bypasses it).
	if (toolName === "subagent") {
		const swarmBlock = await gateSwarmCall(input, ctx, options);
		if (swarmBlock) return swarmBlock;
	}

	if (ctx.mode === "plan") {
		const reason = planModeBlockReason(toolName, input);
		return reason ? { block: true, reason } : undefined;
	}

	if (ctx.mode !== "manual") return undefined;
	if (!isMutatingTool(toolName)) return undefined;

	let action: string;
	let detail: string;

	if (toolName === "bash") {
		action = "bash";
		detail = sanitizeDetail(input.command);
	} else if (toolName === "edit" || toolName === "write") {
		const path = resolvePath(cwd, input.path);
		const outside = path ? isPathOutsideCwd(path, cwd) : false;
		action = outside ? `${toolName}-outside` : toolName;
		detail = path || String(input.path ?? "");
	} else if (toolName === "behavior_add" || toolName === "memory_add") {
		action = toolName;
		detail = sanitizeDetail(input.content);
	} else if (toolName === "behavior_remove" || toolName === "memory_remove") {
		action = toolName;
		detail = sanitizeDetail(input.line);
	} else if (toolName === "cron") {
		action = "cron";
		detail = sanitizeDetail(input.action);
	} else {
		// All other mutating tools fall back to the tool name with no extra detail.
		action = toolName;
		detail = "";
	}

	if (ctx.approvals.has(action)) return undefined;

	if (!approvalHandler) {
		return { block: true, reason: NO_HANDLER_REASON };
	}

	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({ toolName, action, detail });
	} catch (err) {
		const message = err instanceof Error ? err.message : NO_HANDLER_REASON;
		return { block: true, reason: message };
	}

	const decision = typeof resp === "string" ? resp : resp.decision;
	if (decision === "session") {
		ctx.approvals.add(action);
		return undefined;
	}
	if (decision === "reject") {
		const feedback = typeof resp === "string" ? undefined : resp.feedback?.trim();
		return { block: true, reason: feedback ? `${REJECT_REASON} ${feedback}` : REJECT_REASON };
	}
	// "once" — allow this call only
	return undefined;
}
