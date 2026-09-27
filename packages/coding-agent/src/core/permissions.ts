/**
 * lunR: permission modes (YOLO / Auto / Read-only).
 *
 * Per-session only, with a configurable default for new sessions.
 *
 * - yolo: auto-approve tools; the agent may still ask questions.
 * - auto: fully autonomous; a system-prompt addendum steers the model to
 *         self-decide, and rollback is force-enabled for the session.
 * - read-only: mutating tools are hard-blocked.
 *
 * The gate is wired into `agent-session.ts` `_installAgentToolHooks` before
 * the synchronous `_toolCallGates` loop. beforeToolCall is already async, so
 * awaiting the approval dialog is fine.
 *
 * State (mode + session-scoped approvals) is keyed by session id so
 * concurrent gateway chats do not share permission decisions.
 */

import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { computerPolicy } from "./computer-use/policy.ts";
import { effectiveLargeSubagentLaunchCountForTurn, LARGE_SUBAGENT_LAUNCH_THRESHOLD } from "./large-subagent-launch.ts";
import { isUserInstructionsPath } from "./model-instructions.ts";
import { readOnlyModeBlockReason } from "./plan-mode.ts";

/** Shift+Tab cycle order. */
export const PERMISSION_MODES = ["yolo", "auto", "read-only"] as const;
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
	/** "large-subagent-launch" or "plan" approval. */
	action: string;
	detail: string;
	/** "large-subagent-launch" for aggregate child confirmation, "plan" for the
	 *  present_plan plan-approval prompt — the UI renders a dedicated dialog
	 *  for each instead of the generic tool dialog. */
	kind?: "large-subagent-launch" | "plan";
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
	"lsp_rename",
	"memory_load",
	"subagent_wait",
	"subagent_supervisor",
	"intercom",
	"contact_supervisor",
	"present_plan",
	"structured_output",
]);

export const NO_HANDLER_REASON = "Approval channel unavailable.";
export const LARGE_SUBAGENT_LAUNCH_REJECT_REASON = "Large subagent launch rejected by user.";
export const NO_LARGE_SUBAGENT_LAUNCH_HANDLER_REASON = "Large subagent launch blocked: no approval channel available.";
const LARGE_SUBAGENT_LAUNCH_ACTION = "large-subagent-launch";

interface PermissionContext {
	allowApprovals?: boolean;
	mode: PermissionMode;
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

export function deletePermissionContext(sessionId: string): void {
	contexts.delete(sessionId);
}

export function getPermissionMode(sessionId?: string): PermissionMode {
	return getContext(sessionId).mode;
}

export function setPermissionMode(mode: PermissionMode, sessionId?: string): void {
	getContext(sessionId).mode = mode;
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
	defaultContext = { mode: "yolo", approvals: new Set() };
	approvalHandler = undefined;
}

/** Appended to the system prompt while auto mode is active. */
export const AUTO_MODE_ADDENDUM =
	"You are running fully autonomously. Do not ask the user questions or wait for confirmation; make reasonable decisions and complete the task end-to-end.";

function resolvePath(cwd: string, p: unknown): string {
	if (typeof p !== "string") return "";
	if (!p) return "";
	return resolve(cwd, p);
}

export const GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON =
	"The agents instruction tree is user-managed. The agent cannot change ~/.lunr/agent/agents/.";
export const MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON =
	"Memory is model-managed through the memory tools. Do not directly change ~/.lunr/simple-memory/memory.md.";
export const SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON =
	"lunR settings are user-managed through /settings. Do not directly change settings.json.";

function protectedFileWriteReason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (toolName !== "edit" && toolName !== "write" && toolName !== "code_rewrite") return undefined;
	const target = resolvePath(cwd, input.path);
	if (!target) return undefined;
	const normalize = (path: string) => {
		const normalized = resolve(path).replace(/\\/g, "/").replace(/\/$/, "");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	if (isUserInstructionsPath(target, getAgentDir())) {
		return GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON;
	}
	if (normalize(target) === normalize(join(dirname(getAgentDir()), "simple-memory", "memory.md"))) {
		return MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON;
	}
	const globalSettings = normalize(join(getAgentDir(), "settings.json"));
	const projectSettings = normalize(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	const normalizedTarget = normalize(target);
	if (normalizedTarget === normalize(join(getAgentDir(), "install-features.json"))) {
		return "Optional features are user-managed through lunr features; Browser is managed in /settings. Do not change install-features.json directly.";
	}
	if (normalizedTarget === globalSettings || normalizedTarget === projectSettings) {
		return SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON;
	}
	return undefined;
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
 * Aggregate launch gate. A launch above LARGE_SUBAGENT_LAUNCH_THRESHOLD
 * parallel subagents in one `tasks`/`chain.parallel` call, or that many same-turn
 * SINGLE `subagent` calls) requires user approval in yolo mode; auto
 * mode runs it unconditionally.
 * Fail-closed without an approval handler.
 */
async function gateLargeSubagentLaunch(
	input: Record<string, unknown>,
	ctx: PermissionContext,
	options?: GateOptions,
): Promise<{ block: true; reason: string } | undefined> {
	if (ctx.mode === "auto") return undefined;
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

/**
 * Returns a block result when the tool call should be blocked, else undefined.
 * Read-only tools always pass. YOLO and Auto pass mutating tools. Read-only
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
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;

	if (ctx.mode === "read-only") {
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
	if (toolName === "subagent") {
		const launchResult = await gateLargeSubagentLaunch(input, ctx, options);
		if (launchResult) return launchResult;
	}
	return undefined;
}
