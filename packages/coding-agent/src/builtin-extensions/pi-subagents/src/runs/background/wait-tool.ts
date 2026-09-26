// @ts-nocheck
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

const WAIT_INTERRUPTION_SYMBOL = Symbol.for("@lunr/subagent-wait-interruption");

function registerWaitInterruption(sessionId: string | null | undefined) {
	if (!sessionId) return undefined;
	const bridge = (globalThis as Record<symbol, unknown>)[WAIT_INTERRUPTION_SYMBOL] as
		| {
				owners?: Map<
					string,
					{
						register(): {
							signal: AbortSignal;
							wasInterrupted(): boolean;
							unregister(): void;
						};
					}
				>;
		  }
		| undefined;
	return bridge?.owners?.get(sessionId)?.register();
}

function interruptedResult(): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: "Wait interrupted by user input; background work remains active." }],
		details: { mode: "management", results: [] },
	};
}

export function registerWaitTool(
	pi: ExtensionAPI,
	state: SubagentState,
	enabled = resolveWaitToolConfig().enabled,
	waitForPendingLaunches?: (signal?: AbortSignal) => Promise<void>,
): void {
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Block until background work owned by this session changes, then return.

Call this when the current turn or skill must finish after its children. For normal interactive completion, yield and let lunR wake the session. Headless sessions auto-drain current-session work after the agent turn.

• { } — return when the first initially active async run or registered provider item finishes, or when a subagent needs attention.
• { all: true } — wait for every async run and provider item that was active when the call began.
• { id: "..." } — wait for one async or remembered detached foreground subagent run (id or prefix).
• { questionId: "..." } — wait for one supervisor question from subagent_supervisor action='ask' (answered/expired/cancelled). Separate from final run results.
• { timeoutMs: 600000 } — stop waiting after N ms; active work keeps running.

Provider jobs are session-scoped and identified exactly, so replacing one job with another cannot hide a completion. Provider extensions must be explicitly loaded in this process. In a child agent, keep \`subagent_wait\` in the child tool allowlist and load each provider through the agent's extensions or subagentOnlyExtensions; this tool never loads providers or grants tools itself.${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		async execute(_id, params, signal) {
			await Promise.resolve();
			const interruption = registerWaitInterruption(state.currentSessionId);
			const waitSignal = interruption
				? signal
					? AbortSignal.any([signal, interruption.signal])
					: interruption.signal
				: signal;
			try {
				try {
					await waitForPendingLaunches?.(waitSignal);
				} catch (error) {
					if (interruption?.wasInterrupted()) return interruptedResult();
					throw error;
				}
				if (interruption?.wasInterrupted()) return interruptedResult();
				signal?.throwIfAborted();
				return waitForSubagents(params, waitSignal, {
					state,
					events: pi.events,
					enabled,
					wasInterrupted: interruption?.wasInterrupted,
				});
			} finally {
				interruption?.unregister();
			}
		},
	};
	pi.registerTool(tool);
}
