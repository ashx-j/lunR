/**
 * The hooks AgentSession installs on its Agent around every tool call: ordering of state-changing
 * calls, the permission gate, auto review, host gates, the rollback snapshot and the extension
 * tool_call and tool_result handlers. AgentSession installs them once in its constructor and
 * supplies the session state they read through ToolCallHooksHost.
 */

import { dirname, join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../config.ts";
import { needsAutoReview } from "./auto-review.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { CompiledPermissionRules } from "./permission-rules.ts";
import { gateToolCall, type PermissionMode } from "./permissions.ts";
import { readOnlyModeBlockReason } from "./plan-mode.ts";
import { rollbackSnapshotBeforeWrite } from "./rollback.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { BashJobs } from "./tools/bash-jobs.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

// lunr: core-owned tool-call gate. return { block: true, reason } to prevent
// execution; the agent loop turns it into an error tool result shown to the model.
export interface ToolCallGateResult {
	block: boolean;
	reason?: string;
}
export type ToolCallGate = (
	toolName: string,
	input: Record<string, unknown>,
	toolCallId: string,
) => ToolCallGateResult | undefined | Promise<ToolCallGateResult | undefined>;

/** What the tool-call hooks read from AgentSession, each at call time (the Agent is a parameter, set once). AgentSession builds one in `createToolCallHooksHost`. */
export interface ToolCallHooksHost {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly sessionId: string;
	readonly permissionMode: PermissionMode;
	/** False for ACP sessions, whose clients approve tools themselves. */
	readonly autoReviewEnabled: boolean;
	readonly toolCallGates: readonly ToolCallGate[];
	/** Read at each call, so an extension reload swaps in the new runner without reinstalling hooks. */
	readonly extensionRunner: ExtensionRunner;
	readonly bashJobs: BashJobs;
	permissionRules(): CompiledPermissionRules;
	reviewAutoAction(toolName: string, args: unknown, toolCallId: string): Promise<string | undefined>;
}

/**
 * Install tool hooks once on the Agent instance.
 *
 * The callbacks read `host.extensionRunner` at execution time, so extension reload swaps in the
 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
 * registered tool execution to the extension context. Tool call and tool result interception now
 * happens here instead of in wrappers.
 */
export function installToolCallHooks(agent: Agent, host: ToolCallHooksHost): void {
	// lunr: calls read-only mode knows to change state (edit, write, mutating bash, ...) run in
	// the order the model wrote them; other calls in the same message still run concurrently.
	// Unknown extension tools stay concurrent; they can opt out with executionMode "sequential".
	agent.toolCallMutates = (toolCall, args) => readOnlyModeBlockReason(toolCall.name, args) !== undefined;
	agent.beforeToolCall = async ({ toolCall, args, assistantMessage }) => {
		// lunr: the permission gate runs before host gates and may request approval.
		const rules = host.permissionRules();
		const permBlock = await gateToolCall(toolCall.name, args as Record<string, unknown>, host.cwd, host.sessionId, {
			confirmLargeSubagentLaunches: host.settingsManager.getConfirmLargeSubagentLaunches(),
			assistantMessage,
			rules,
			saveAllowRule: (rule) => host.settingsManager.addPermissionAllowRule(rule),
		});
		if (permBlock) {
			return { block: true, reason: permBlock.reason };
		}
		if (
			host.permissionMode === "auto" &&
			host.autoReviewEnabled &&
			needsAutoReview(toolCall.name, args as Record<string, unknown>, host.cwd) &&
			!rules.allowed(toolCall.name, args as Record<string, unknown>)
		) {
			const reviewBlock = await host.reviewAutoAction(toolCall.name, args, toolCall.id);
			if (reviewBlock) return { block: true, reason: reviewBlock };
		}

		// lunr: await host gates before snapshots, extension handlers or tool execution.
		for (const gate of host.toolCallGates) {
			const gateResult = await gate(toolCall.name, args as Record<string, unknown>, toolCall.id);
			if (gateResult?.block) {
				return { block: true, reason: gateResult.reason };
			}
		}

		// lunr: rollback snapshot — capture pre-write content for mutating tools before they run.
		try {
			const toolName = toolCall.name;
			const argPath =
				args && typeof args === "object" && "path" in args
					? resolveToCwd(String((args as Record<string, unknown>).path), host.cwd)
					: undefined;
			const pathsToSnapshot: string[] = [];
			if (toolName === "edit" || toolName === "write") {
				if (argPath) pathsToSnapshot.push(argPath);
			} else if (toolName === "memory_add" || toolName === "memory_remove") {
				// lunr: simple-memory lives next to the lunr agent dir (~/.lunr/simple-memory)
				pathsToSnapshot.push(join(dirname(getAgentDir()), "simple-memory", "memory.md"));
			} else if (toolName === "cron" && args && typeof args === "object") {
				const action = String((args as Record<string, unknown>).action ?? "");
				if (action === "create" || action === "update" || action === "remove") {
					pathsToSnapshot.push(join(getAgentDir(), "cron", "jobs.json"));
				}
			}
			for (const p of pathsToSnapshot) {
				rollbackSnapshotBeforeWrite(p, host.sessionId);
			}
		} catch {
			// rollback failures must never block the tool call
		}

		const runner = host.extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		// A job that exited during the run is announced in the next tool result, which the
		// next request carries anyway. Steering would cost an extra request after a final answer.
		const jobNotice = host.bashJobs.takeExitNotices();
		if (jobNotice) result = { ...result, content: [...result.content, { type: "text", text: jobNotice }] };
		const unchanged = jobNotice ? { content: result.content } : undefined;
		const runner = host.extensionRunner;
		if (!runner.hasHandlers("tool_result")) {
			return unchanged;
		}

		const hookResult = await runner.emitToolResult({
			type: "tool_result",
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			input: args as Record<string, unknown>,
			content: result.content,
			details: result.details,
			isError,
		});

		if (!hookResult) {
			return unchanged;
		}

		return {
			content: hookResult.content,
			details: hookResult.details,
			isError: hookResult.isError ?? isError,
		};
	};
}
