/**
 * lunR: permission modes (Manual / YOLO / Auto).
 *
 * Per-session only — never persisted per session, but the default mode new
 * sessions start with is configurable in /settings (`defaultPermissionMode`,
 * default "manual").
 *
 * - manual: every mutating tool call (bash, edit, write) requires approval.
 * - yolo:   auto-approve tools; the agent may still ask questions.
 * - auto:   fully autonomous; a system-prompt addendum steers the model to
 *           self-decide, and rollback is force-enabled for the session.
 *
 * The gate is wired into `agent-session.ts` `_installAgentToolHooks` before
 * the synchronous `_toolCallGates` loop (plan mode etc.). beforeToolCall is
 * already async, so awaiting the approval dialog is fine.
 *
 * State (mode + session-scoped approvals) is keyed by session id so
 * concurrent gateway chats do not share permission decisions.
 */

import { resolve } from "node:path";

export type PermissionMode = "manual" | "yolo" | "auto";

export interface ApprovalRequest {
	toolName: string;
	/** "bash" (detail = command), "edit"/"write" (detail = path),
	 *  "edit-outside"/"write-outside" when path escapes cwd. */
	action: string;
	detail: string;
}

export type ApprovalResponse = "once" | "session" | "reject";

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

function sanitizeDetail(value: unknown): string {
	const text = String(value ?? "").trim();
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Returns a block result when the tool call should be blocked, else undefined.
 * Read-only tools always pass. YOLO and Auto always pass. Manual mode gates
 * every mutating tool; if an approval handler is registered it is asked,
 * otherwise the call is blocked (fail-closed — no silent allow).
 */
export async function gateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	sessionId?: string,
): Promise<{ block: true; reason: string } | undefined> {
	const ctx = getContext(sessionId);
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;
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

	if (resp === "session") {
		ctx.approvals.add(action);
		return undefined;
	}
	if (resp === "reject") {
		return { block: true, reason: REJECT_REASON };
	}
	// "once" — allow this call only
	return undefined;
}
