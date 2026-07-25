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
]);

const REJECT_REASON = "Rejected by user (permission mode: manual).";

let currentMode: PermissionMode = "manual";
const sessionApprovals = new Set<string>();
let approvalHandler: ((req: ApprovalRequest) => Promise<ApprovalResponse>) | undefined;

export function getPermissionMode(): PermissionMode {
	return currentMode;
}

export function setPermissionMode(mode: PermissionMode): void {
	currentMode = mode;
}

export function resetPermissions(defaultMode: PermissionMode = "manual"): void {
	currentMode = defaultMode;
	sessionApprovals.clear();
}

export function registerApprovalHandler(fn: ((req: ApprovalRequest) => Promise<ApprovalResponse>) | undefined): void {
	approvalHandler = fn;
}

export function clearSessionApprovals(): void {
	sessionApprovals.clear();
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

/**
 * Returns a block result when the tool call should be blocked, else undefined.
 * Read-only tools always pass. YOLO and Auto always pass. Manual mode asks
 * the approval handler (if registered) or allows (no handler = non-TUI safety).
 */
export async function gateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (READ_ONLY_TOOLS.has(toolName)) return undefined;
	if (currentMode !== "manual") return undefined;

	let action: string;
	let detail: string;

	if (toolName === "bash") {
		action = "bash";
		detail = String(input.command ?? "").trim();
	} else if (toolName === "edit" || toolName === "write") {
		const path = resolvePath(cwd, input.path);
		const outside = path ? isPathOutsideCwd(path, cwd) : false;
		action = outside ? `${toolName}-outside` : toolName;
		detail = path || String(input.path ?? "");
	} else {
		return undefined;
	}

	if (sessionApprovals.has(action)) return undefined;

	if (!approvalHandler) return undefined;

	const resp = await approvalHandler({ toolName, action, detail });

	if (resp === "session") {
		sessionApprovals.add(action);
		return undefined;
	}
	if (resp === "reject") {
		return { block: true, reason: REJECT_REASON };
	}
	// "once" — allow this call only
	return undefined;
}
