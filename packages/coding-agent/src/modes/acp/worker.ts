import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	PERMISSION_MODES,
	type PermissionMode,
	registerApprovalHandler,
	restorePermissionModeAfterPlan,
} from "../../core/permissions.ts";
import { getSubagentCancellation } from "../../core/subagent-cancellation.ts";
import type { RpcAcpPermissionRequest, RpcExtensionUIResponse } from "../rpc/rpc-types.ts";
import { ACP_WORKER_CONFIG_ENV, readAcpWorkerConfig } from "./worker-config.ts";

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
	"structured_output",
	"present_plan",
]);

export function assertRpcConfigurationIdle(
	session: Pick<AgentSession, "isIdle" | "isCompacting" | "isRetrying" | "isBashRunning">,
): void {
	if (!session.isIdle || session.isCompacting || session.isRetrying || session.isBashRunning) {
		throw new Error("Cannot change configuration while the session is active.");
	}
}

export function setRpcPermissionMode(
	session: Pick<AgentSession, "isIdle" | "isCompacting" | "isRetrying" | "isBashRunning" | "setPermissionMode">,
	mode: unknown,
): void {
	const validatedMode = PERMISSION_MODES.find((allowed) => allowed === mode);
	if (!validatedMode) throw new Error("Invalid permission mode.");
	assertRpcConfigurationIdle(session);
	session.setPermissionMode(validatedMode);
}

export interface AcpWorkerBridge {
	beginTurn(): void;
	respond(response: RpcExtensionUIResponse): boolean;
	cancel(): void;
	hasPendingWork(): boolean;
	permissionModeChanged(): void;
	stopChildren(): Promise<void>;
	dispose(): void;
}

// one rpc worker owns one acp session, including its pending host approvals.
export function createAcpWorkerBridge(
	session: Pick<AgentSession, "addToolCallGate" | "sessionId"> & {
		agent?: Pick<AgentSession["agent"], "signal">;
		permissionMode?: PermissionMode;
		setPermissionMode?: AgentSession["setPermissionMode"];
		settingsManager?: Pick<AgentSession["settingsManager"], "getDefaultPermissionMode">;
	},
	output: (request: RpcAcpPermissionRequest) => void,
): AcpWorkerBridge | undefined {
	if (!readAcpWorkerConfig()) return undefined;
	delete process.env[ACP_WORKER_CONFIG_ENV];
	const pending = new Map<string, (approved: boolean) => void>();
	let cancelled = false;
	let previousWritableMode: PermissionMode | undefined;
	const permissionModeChanged = () => {
		if (session.permissionMode && session.permissionMode !== "read-only")
			previousWritableMode = session.permissionMode;
	};
	permissionModeChanged();
	const approve = (
		toolCallId: string,
		toolName: string,
		input: Record<string, unknown>,
		description?: string,
		standalone?: boolean,
	): Promise<boolean> => {
		const signal = session.agent?.signal;
		if (cancelled || signal?.aborted) return Promise.resolve(false);
		const id = randomUUID();
		return new Promise((resolve) => {
			const finish = (approved: boolean) => {
				pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				resolve(approved);
			};
			const onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, finish);
			try {
				output({ type: "acp_permission_request", id, toolCallId, toolName, input, description, standalone });
			} catch {
				finish(false);
			}
		});
	};
	const removeGate = session.addToolCallGate(async (toolName, input, toolCallId) => {
		if (cancelled) return { block: true, reason: "ACP request cancelled." };
		if (READ_TOOLS.has(toolName)) return undefined;
		const description =
			toolName === "subagent"
				? "Approving full-access delegation authorizes the child's tools without individual ACP permission requests."
				: undefined;
		return (await approve(toolCallId, toolName, input, description))
			? undefined
			: { block: true, reason: cancelled ? "ACP request cancelled." : "Tool execution denied by ACP client." };
	});
	registerApprovalHandler(async (request) => {
		const approved = await approve(
			`approval-${randomUUID()}`,
			request.toolName,
			{ action: request.action, detail: request.detail, kind: request.kind },
			request.kind === "large-subagent-launch"
				? `${request.detail}\nApproving full-access delegation authorizes the child's tools without individual ACP permission requests.`
				: request.detail,
			true,
		);
		if (!approved) return "reject";
		if (request.kind === "plan") {
			const target = restorePermissionModeAfterPlan(
				previousWritableMode,
				session.settingsManager?.getDefaultPermissionMode() ?? "yolo",
			);
			session.setPermissionMode?.(target === "read-only" ? "yolo" : target);
			permissionModeChanged();
		}
		return "once";
	});
	const cancel = () => {
		cancelled = true;
		for (const resolve of pending.values()) resolve(false);
		pending.clear();
	};
	return {
		beginTurn() {
			cancelled = false;
			permissionModeChanged();
		},
		respond(response) {
			const resolve = pending.get(response.id);
			if (!resolve) return false;
			pending.delete(response.id);
			resolve("confirmed" in response && response.confirmed === true);
			return true;
		},
		cancel,
		permissionModeChanged,
		hasPendingWork() {
			const cancellation = getSubagentCancellation(session.sessionId);
			return cancellation?.hasPendingWork?.() ?? cancellation?.hasActiveRuns() ?? false;
		},
		async stopChildren() {
			const result = await getSubagentCancellation(session.sessionId)?.stop();
			if (result?.failed) throw new Error(`Could not stop ${result.failed} session-owned subagents.`);
		},
		dispose() {
			cancel();
			removeGate();
			registerApprovalHandler(undefined);
		},
	};
}
