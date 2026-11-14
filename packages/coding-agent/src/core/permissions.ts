/**
 * lunR: permission modes (YOLO / Auto / Ask / Read-only).
 *
 * Per-session only, with a configurable default for new sessions.
 *
 * - yolo: auto-approve tools; the agent may still ask questions.
 * - auto: like yolo, but AgentSession sends risky calls to a review model
 *         first (see auto-review.ts), and rollback is force-enabled for the session.
 * - ask: asks the user before every call read-only mode would block. Without
 *        an approval channel such calls are blocked.
 * - read-only: mutating tools are hard-blocked.
 *
 * Allow and deny rules (permission-rules.ts) arrive through GateOptions. Deny
 * rules block in every mode; allow rules skip the ask-mode question and, in
 * AgentSession, the auto review. Neither overrides protected targets or read-only.
 *
 * The gate is wired into `agent-session.ts` `_installAgentToolHooks` before
 * the awaited `_toolCallGates` loop, which can also request host approval.
 *
 * "Autonomous" (no questions, AUTONOMOUS_ADDENDUM) is a separate per-session
 * flag for /goal, subagents and ACP Autonomous, not a mode.
 *
 * State (mode + session-scoped approvals) is keyed by session id so
 * concurrent gateway chats do not share permission decisions.
 */

import { computerPolicy } from "./computer-use/policy.ts";
import { effectiveLargeSubagentLaunchCountForTurn, LARGE_SUBAGENT_LAUNCH_THRESHOLD } from "./large-subagent-launch.ts";
import { type CompiledPermissionRules, suggestAllowRule } from "./permission-rules.ts";
import { readOnlyModeBlockReason } from "./plan-mode.ts";
import { protectedTargetWriteReason } from "./protected-targets.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export {
	GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON,
	MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON,
	SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON,
} from "./protected-targets.ts";

/** Shift+Tab cycle order: each step is stricter than the last, then it wraps to yolo. */
export const PERMISSION_MODES = ["yolo", "auto", "ask", "read-only"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function nextPermissionMode(current: PermissionMode): PermissionMode {
	const i = PERMISSION_MODES.indexOf(current);
	return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
}

/** True when the session is read-only. */
export function isReadOnlyModeActive(sessionId?: string): boolean {
	return getPermissionMode(sessionId) === "read-only";
}

/**
 * Destination mode when leaving a read-only planning session.
 * Explicit Shift+Tab or `/mode` picks do not use this.
 */
export function restorePermissionModeAfterPlan(
	previous: PermissionMode | undefined,
	defaultMode: PermissionMode,
): PermissionMode {
	if (previous && previous !== "read-only") return previous;
	return defaultMode;
}

export interface ApprovalRequest {
	toolName: string;
	/** "large-subagent-launch", "plan", "auto-review" or "ask" approval. */
	action: string;
	detail: string;
	/** "large-subagent-launch" for aggregate child confirmation, "plan" for the
	 *  present_plan plan-approval prompt — the UI renders a dedicated dialog
	 *  for each instead of the generic tool dialog. "auto-review" asks the user to
	 *  decide an action after auto mode's review model kept blocking. "tool" is
	 *  ask mode's question before one call that changes state. */
	kind?: "large-subagent-launch" | "plan" | "auto-review" | "tool";
	/** Heading for a "tool" question. */
	title?: string;
	/** Allow rule an "always" answer saves; absent when no rule can cover the call. */
	rule?: string;
}

/** "always" also saves the request's `rule`; channels that can't save rules never return it. */
export type ApprovalDecision = "once" | "session" | "always" | "reject";
/** Handlers may return a bare decision string, a reject carrying user feedback
 *  that becomes the block reason the model sees, or an approve carrying optional
 *  feedback (plan approval with comments). */
export type ApprovalResponse =
	| ApprovalDecision
	| { decision: "reject"; feedback: string }
	| { decision: "approve"; feedback?: string };

/** Read-only tools that never need approval. ACP extends this list for its client approval gate. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"fetch_content",
	"get_search_content",
	"code_overview",
	"ast_search",
	"lsp_diagnostics",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_symbols",
	"lsp_code_actions",
	"lsp_completions",
	"lsp_rename",
	"memory_load",
	"subagent_wait",
	"pr_watch",
	"subagent_supervisor",
	"intercom",
	"contact_supervisor",
	"present_plan",
	"structured_output",
]);

export const NO_HANDLER_REASON = "Approval channel unavailable.";
/** An approval channel rejects with this when nobody answered a plan prompt in time. */
export const PLAN_APPROVAL_TIMEOUT_REASON = "Plan approval timed out.";
export const LARGE_SUBAGENT_LAUNCH_REJECT_REASON = "Large subagent launch rejected by user.";
export const ASK_REJECT_REASON = "The user rejected this call.";
export const NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON = "Large subagent launch blocked: no approval channel available.";
const LARGE_SUBAGENT_LAUNCH_ACTION = "large-subagent-launch";

interface PermissionContext {
	allowApprovals?: boolean;
	mode: PermissionMode;
	/** Set for /goal, subagents and ACP Autonomous: work without asking the user. */
	autonomous?: boolean;
	approvals: Set<string>;
}

const contexts = new Map<string, PermissionContext>();
let defaultContext: PermissionContext = { mode: "yolo", approvals: new Set() };
let approvalHandler: ((req: ApprovalRequest) => Promise<ApprovalResponse>) | undefined;
/** One aggregate prompt covers every sibling SINGLE `subagent` on the same assistant message. */
const turnLargeLaunchDecisions = new WeakMap<object, { decision: ApprovalDecision; feedback?: string }>();

function getContext(sessionId?: string): PermissionContext {
	if (!sessionId) return defaultContext;
	return contexts.get(sessionId) ?? defaultContext;
}

export function createPermissionContext(
	sessionId: string,
	mode: PermissionMode = defaultContext.mode,
	allowApprovals = true,
): void {
	contexts.set(sessionId, { mode, allowApprovals, approvals: new Set() });
}

/** Initialize shared session defaults without replacing caller-owned approval policy or grants. */
export function initializePermissionContext(
	sessionId: string,
	mode: PermissionMode = defaultContext.mode,
	overrideMode?: PermissionMode,
): void {
	if (!contexts.has(sessionId)) createPermissionContext(sessionId, mode);
	if (overrideMode !== undefined) setPermissionMode(overrideMode, sessionId);
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

/** Marks a session as working without asking the user, which also skips the large-launch confirmation. */
export function setPermissionAutonomous(autonomous: boolean, sessionId?: string): void {
	getContext(sessionId).autonomous = autonomous;
}

export function resetPermissions(defaultMode: PermissionMode = "yolo", sessionId?: string): void {
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
 * lunr: present_plan approval request. Unlike the aggregate launch gate
 * this fails OPEN when no approval handler is registered (or none is reachable,
 * e.g. a gateway turn without a chat context): headless sessions have no one to
 * show the dialog to, so the plan is presented and the user replies in chat
 * instead of deadlocking the turn. A prompt nobody answered in time
 * (PLAN_APPROVAL_TIMEOUT_REASON) reads the same way, not as a decline.
 * Everything else keeps fail-closed.
 */
/**
 * Asks the user to decide an action auto mode's reviewer kept blocking or couldn't review.
 * Returns undefined when no approval channel exists, so the caller keeps the block.
 */
export async function requestAutoReviewDecision(
	request: { toolName: string; detail: string },
	sessionId?: string,
): Promise<"allow" | "reject" | undefined> {
	const ctx = getContext(sessionId);
	if (!approvalHandler || ctx.allowApprovals === false) return undefined;
	const response = await approvalHandler({
		toolName: request.toolName,
		action: "auto-review",
		detail: request.detail,
		kind: "auto-review",
	});
	const decision = typeof response === "string" ? response : response.decision;
	return decision === "reject" ? "reject" : "allow";
}

export async function requestPlanApproval(summary: string): Promise<string> {
	if (!approvalHandler) return PLAN_PASS_THROUGH_TEXT;
	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({ toolName: "present_plan", action: "plan", detail: summary, kind: "plan" });
	} catch (err) {
		const message = err instanceof Error ? err.message : "approval request failed";
		if (message === NO_HANDLER_REASON || message === PLAN_APPROVAL_TIMEOUT_REASON) return PLAN_PASS_THROUGH_TEXT;
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
	defaultContext = { mode: "yolo", approvals: new Set() };
	approvalHandler = undefined;
}

/** Appended to the system prompt while auto mode is active. */
export const AUTONOMOUS_ADDENDUM =
	"You are running fully autonomously. Do not ask the user questions or wait for confirmation; make reasonable decisions and complete the task end-to-end.";

function protectedFileWriteReason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (toolName !== "edit" && toolName !== "write" && toolName !== "code_rewrite") return undefined;
	if (typeof input.path !== "string" || !input.path) return undefined;
	return protectedTargetWriteReason(input.path, cwd);
}

interface RequestedChildLaunch {
	description: string;
	permissions: "full" | "read-only";
}

function collectRequestedChildLaunches(value: unknown, launches: RequestedChildLaunch[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const input = value as Record<string, unknown>;
	if (typeof input.task === "string" && input.task.trim()) {
		launches.push({
			description:
				typeof input.description === "string" && input.description.trim()
					? input.description.trim()
					: input.task.trim(),
			permissions: input.permissions === "read-only" ? "read-only" : "full",
		});
		return;
	}
	for (const key of ["tasks", "chain", "parallel"] as const) {
		const children = input[key];
		if (Array.isArray(children)) {
			for (const child of children) collectRequestedChildLaunches(child, launches);
		} else if (key === "parallel") {
			collectRequestedChildLaunches(children, launches);
		}
	}
}

function getRequestedChildLaunches(input: Record<string, unknown>): RequestedChildLaunch[] {
	const launches: RequestedChildLaunch[] = [];
	collectRequestedChildLaunches(input, launches);
	return launches;
}

export interface GateOptions {
	/** Global preference for aggregate confirmation. Defaults to enabled. */
	confirmLargeSubagentLaunches?: boolean;
	/** Settings allow and deny rules. */
	rules?: CompiledPermissionRules;
	/** Saves an allow rule to global settings after an "always" answer. */
	saveAllowRule?: (rule: string) => void;
	/** Assistant message that issued this tool call. Same-turn sibling SINGLE
	 *  `subagent` calls count toward the aggregate threshold. */
	assistantMessage?: {
		content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }>;
	};
}

function firstTaskText(value: unknown): string {
	if (typeof value === "string" && value.trim()) return sanitizeDetail(value);
	return "";
}

/** First task text of a parallel fan-out or sibling SINGLE, used as the dialog summary. */
function largeLaunchTaskSummary(
	input: Record<string, unknown>,
	assistantMessage?: GateOptions["assistantMessage"],
): string {
	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			const text = task && typeof task === "object" ? firstTaskText((task as { task?: unknown }).task) : "";
			if (text) return text;
		}
	}
	const own = firstTaskText(input.task);
	if (own) return own;
	for (const block of assistantMessage?.content ?? []) {
		if (block.type !== "toolCall" || block.name !== "subagent") continue;
		const args =
			block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: undefined;
		const text = firstTaskText(args?.task);
		if (text) return text;
	}
	return "";
}

/**
 * when confirmation is enabled, launches above the large-launch threshold
 * require approval in yolo, including aggregate same-turn single calls.
 * auto (where the reviewer checks launches) and autonomous sessions bypass
 * confirmation. enabled confirmation fails closed without a handler.
 */
async function gateLargeSubagentLaunch(
	input: Record<string, unknown>,
	ctx: PermissionContext,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	if (ctx.mode === "auto" || ctx.autonomous) return undefined;
	if (options?.confirmLargeSubagentLaunches === false) return undefined;
	const count = effectiveLargeSubagentLaunchCountForTurn(input, options?.assistantMessage);
	if (count <= LARGE_SUBAGENT_LAUNCH_THRESHOLD) return undefined;
	if (ctx.approvals.has(LARGE_SUBAGENT_LAUNCH_ACTION)) return undefined;

	const turnKey = options?.assistantMessage;
	const cached = turnKey ? turnLargeLaunchDecisions.get(turnKey) : undefined;
	if (cached) {
		if (cached.decision === "reject") {
			return {
				block: true,
				reason: cached.feedback
					? `${LARGE_SUBAGENT_LAUNCH_REJECT_REASON} ${cached.feedback}`
					: LARGE_SUBAGENT_LAUNCH_REJECT_REASON,
			};
		}
		return undefined;
	}

	if (!approvalHandler || ctx.allowApprovals === false) {
		return { block: true, reason: NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON };
	}

	const summary = largeLaunchTaskSummary(input, options?.assistantMessage);
	const siblingLaunches = (options?.assistantMessage?.content ?? []).flatMap((block) => {
		if (block.type !== "toolCall" || block.name !== "subagent") return [];
		const args =
			block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
				? (block.arguments as Record<string, unknown>)
				: undefined;
		return args ? getRequestedChildLaunches(args) : [];
	});
	const launches = siblingLaunches.length > 0 ? siblingLaunches : getRequestedChildLaunches(input);
	const launchSummary = launches
		.map((launch) => `${launch.description}\npermissions: ${launch.permissions}`)
		.join("\n");
	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({
			toolName: "subagent",
			action: LARGE_SUBAGENT_LAUNCH_ACTION,
			detail: `large subagent launch (${count} children)${launchSummary || summary ? `\n${launchSummary || summary}` : ""}`,
			kind: "large-subagent-launch",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON;
		return { block: true, reason: message };
	}

	const rawDecision = typeof resp === "string" ? resp : resp.decision;
	const decision: ApprovalDecision = rawDecision === "approve" ? "once" : rawDecision;
	const feedback = typeof resp === "string" ? undefined : resp.feedback?.trim();
	if (turnKey) {
		turnLargeLaunchDecisions.set(turnKey, { decision, ...(feedback ? { feedback } : {}) });
	}
	if (decision === "session") {
		ctx.approvals.add(LARGE_SUBAGENT_LAUNCH_ACTION);
		return undefined;
	}
	if (decision === "reject") {
		return {
			block: true,
			reason: feedback ? `${LARGE_SUBAGENT_LAUNCH_REJECT_REASON} ${feedback}` : LARGE_SUBAGENT_LAUNCH_REJECT_REASON,
		};
	}
	return undefined;
}

function sanitizeDetail(value: unknown): string {
	const text = String(value ?? "").trim();
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** What a session approval covers: the exact command, the exact file, or the whole tool otherwise. */
function askApprovalKey(toolName: string, input: Record<string, unknown>, cwd: string): string {
	if (toolName === "bash" && typeof input.command === "string") return `ask:bash:${input.command.trim()}`;
	if (typeof input.path === "string" && input.path) return `ask:${toolName}:${resolveToCwd(input.path, cwd)}`;
	if (toolName === "mcp" && typeof input.tool === "string")
		return `ask:mcp:${String(input.server ?? "")}/${input.tool}`;
	return `ask:${toolName}`;
}

function askQuestion(toolName: string, input: Record<string, unknown>): { title: string; detail: string } {
	if (toolName === "subagent") {
		const children = getRequestedChildLaunches(input).filter((child) => child.permissions === "full");
		const warning = "It runs commands and edits files without asking you.";
		if (children.length === 0) {
			return {
				title: `Allow subagent ${String(input.action)}? ${warning}`,
				detail: sanitizeDetail(JSON.stringify(input)),
			};
		}
		return {
			title: `Launch ${children.length === 1 ? "a full-access subagent" : `${children.length} full-access subagents`}? ${warning}`,
			detail: sanitizeDetail(children.map((child) => child.description).join("\n")),
		};
	}
	const detail =
		toolName === "bash"
			? input.command
			: typeof input.path === "string"
				? input.path
				: JSON.stringify(input, null, 1);
	return { title: `Allow ${toolName}?`, detail: String(detail ?? "").slice(0, 2000) };
}

/**
 * Ask mode: a call read-only mode would block runs only after the user allows it, an allow rule
 * covers it or an earlier "this session" answer covers it. Without an approval channel (print
 * mode, cron, a subagent) it is blocked with a reason that says how to proceed.
 */
async function gateAskMode(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	ctx: PermissionContext,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	if (!readOnlyModeBlock(toolName, input) || options?.rules?.allowed(toolName, input)) return undefined;
	const key = askApprovalKey(toolName, input, cwd);
	if (ctx.approvals.has(key)) return undefined;
	const rule = suggestAllowRule(toolName, input, cwd);
	if (!approvalHandler || ctx.allowApprovals === false) {
		return {
			block: true,
			reason: `Ask mode needs the user's approval for this ${toolName} call, and nobody can answer here (print mode, cron or a subagent), so it did not run. Tell the user what you need to run. They can allow it with ${rule ? `the rule "${rule}"` : `a "${toolName}" rule`} in permissions.allow in settings.json, or run in yolo or auto mode.`,
		};
	}
	const question = askQuestion(toolName, input);
	let resp: ApprovalResponse;
	try {
		resp = await approvalHandler({
			toolName,
			action: "ask",
			kind: "tool",
			title: question.title,
			detail: question.detail,
			...(rule && options?.saveAllowRule ? { rule } : {}),
		});
	} catch (err) {
		return { block: true, reason: err instanceof Error ? err.message : NO_HANDLER_REASON };
	}
	const decision = typeof resp === "string" ? resp : resp.decision;
	if (decision === "reject") {
		const feedback = typeof resp === "string" ? undefined : resp.feedback?.trim();
		return {
			block: true,
			reason: feedback
				? `${ASK_REJECT_REASON} Their feedback: ${feedback}`
				: `${ASK_REJECT_REASON} Don't retry it; ask the user how to proceed.`,
		};
	}
	if (decision === "always" && rule) options?.saveAllowRule?.(rule);
	if (decision === "session" || decision === "always") ctx.approvals.add(key);
	return undefined;
}

/**
 * Returns a block result when the tool call should be blocked, else undefined.
 * Protected targets and deny rules block first. Read-only tools always pass.
 * YOLO and Auto pass mutating tools. Ask mode asks before them. Read-only
 * mode hard-blocks mutating tools without prompting.
 */
export async function gateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	sessionId?: string,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	const ctx = getContext(sessionId);
	if (toolName.startsWith("computer_")) {
		try {
			computerPolicy(toolName, input);
		} catch (error) {
			return { block: true, reason: String(error) };
		}
	}
	const protectedWriteReason = protectedFileWriteReason(toolName, input, cwd);
	if (protectedWriteReason) {
		return { block: true, reason: protectedWriteReason };
	}
	const deniedBy = options?.rules?.denied(toolName, input);
	if (deniedBy) {
		return {
			block: true,
			reason: `The deny rule "${deniedBy}" in settings blocks this call. Don't reach the same result another way; tell the user what you need.`,
		};
	}
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;

	if (ctx.mode === "read-only") return readOnlyModeBlock(toolName, input);
	if (ctx.mode === "ask") {
		const askBlock = await gateAskMode(toolName, input, cwd, ctx, options);
		if (askBlock) return askBlock;
	}
	if (toolName === "subagent") {
		const launchResult = await gateLargeSubagentLaunch(input, ctx, options);
		if (launchResult) return launchResult;
	}
	return undefined;
}

/**
 * Read-only mode's verdict for one tool call. ACP reuses it when the client
 * switches to read-only while an approval for that call is still open.
 */
export function readOnlyModeBlock(
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;
	const reason = readOnlyModeBlockReason(toolName, input);
	if (reason) return { block: true, reason };
	if (toolName === "mcp") {
		if (input.tool || input.connect || (input.action && input.action !== "ui-messages")) {
			return { block: true, reason: "Read-only mode blocks MCP tool calls, connections, and authentication." };
		}
		return undefined;
	}
	if (toolName === "subagent") {
		const action = input.action;
		if (
			getRequestedChildLaunches(input).some((child) => child.permissions === "full") ||
			action === "resume" ||
			action === "steer" ||
			action === "append-step" ||
			action === "schedule" ||
			action === "schedule-cancel"
		) {
			return {
				block: true,
				reason: "Read-only mode cannot launch full-access children or change running children.",
			};
		}
		return undefined;
	}
	if (toolName.startsWith("computer_")) return undefined;
	if (toolName === "bash" || toolName === "browser" || toolName === "code_rewrite") return undefined;
	return { block: true, reason: `Read-only mode cannot verify that ${toolName} is safe.` };
}
