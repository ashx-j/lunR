import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	PERMISSION_MODES,
	type PermissionMode,
	READ_ONLY_TOOLS,
	readOnlyModeBlock,
	registerApprovalHandler,
	restorePermissionModeAfterPlan,
} from "../../core/permissions.ts";
import { getSubagentCancellation } from "../../core/subagent-cancellation.ts";
import type { RpcAcpPermissionRequest, RpcExtensionUIResponse } from "../rpc/rpc-types.ts";
import { ACP_WORKER_CONFIG_ENV, readAcpWorkerConfig } from "./worker-config.ts";

export function assertRpcConfigurationIdle(
	session: Pick<AgentSession, "isIdle" | "isCompacting" | "isRetrying" | "isBashRunning">,
): void {
	if (!session.isIdle || session.isCompacting || session.isRetrying || session.isBashRunning) {
		throw new Error("Cannot change configuration while the session is active.");
	}
}

// tool gates read the mode on each call, so it can change mid-turn like shift+tab in the tui.
export function setRpcPermissionMode(session: Pick<AgentSession, "setPermissionMode">, mode: unknown): void {
	const validatedMode = PERMISSION_MODES.find((allowed) => allowed === mode);
	if (!validatedMode) throw new Error("Invalid permission mode.");
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
		setAutonomous?: AgentSession["setAutonomous"];
		setAutoReviewEnabled?: AgentSession["setAutoReviewEnabled"];
		settingsManager?: Pick<AgentSession["settingsManager"], "getDefaultPermissionMode">;
	},
	output: (request: RpcAcpPermissionRequest) => void,
): AcpWorkerBridge | undefined {
	if (!readAcpWorkerConfig()) return undefined;
	delete process.env[ACP_WORKER_CONFIG_ENV];
	const pending = new Map<string, (approved: boolean) => void>();
	let cancelled = false;
	let previousWritableMode: PermissionMode | undefined;
	// ACP's "auto" is Autonomous: no questions, while the client still approves each tool, so no auto review.
	session.setAutoReviewEnabled?.(false);
	const permissionModeChanged = () => {
		session.setAutonomous?.(session.permissionMode === "auto");
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
		if (READ_ONLY_TOOLS.has(toolName)) return undefined;
		const description =
			toolName === "subagent"
				? "Approving full-access delegation authorizes the child's tools without individual ACP permission requests."
				: undefined;
		if (!(await approve(toolCallId, toolName, input, description)))
			return { block: true, reason: cancelled ? "ACP request cancelled." : "Tool execution denied by ACP client." };
		// the client can switch to read-only while this approval is open; apply that mode before the tool runs.
		return session.permissionMode === "read-only" ? readOnlyModeBlock(toolName, input) : undefined;
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
