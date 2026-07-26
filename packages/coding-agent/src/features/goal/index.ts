/**
 * Goal — run a goal to completion (absorbed from the former narumiruna-pi-goal
 * baked-in extension into core).
 *
 * `index.ts` is the composition root: it keeps tool contracts and event
 * orchestration together. Per-session mechanisms live in runtime.ts, while user
 * command transitions live in commands.ts. One process-wide singleton holds the
 * mutable goal state (the extension was a per-factory singleton, i.e. the same).
 *
 * Wiring (no extension events involved anymore):
 * - Tools (`goal_complete`/`goal_blocked`) are customTools assembled in main.ts.
 * - `/goal` is a built-in slash command dispatched by InteractiveMode.
 * - Agent-event hooks (input/context/tool_call/before_agent_start/compaction)
 *   are direct calls from agent-session.ts / sdk.ts.
 * - Lifecycle hooks (session_start/shutdown) and agent_end/tool_execution_end/
 *   agent_settled are driven from InteractiveMode.
 *
 * The runtime still talks to the session through a small host adapter (the old
 * `pi: ExtensionAPI` surface): sendUserMessage/sendMessage/appendEntry/
 * getActiveTools/setActiveTools, all delegating to the CURRENT session via
 * `deps.getSession()` so session replacement keeps working.
 */

import { Type } from "@sinclair/typebox";
import type { AgentSession } from "../../core/agent-session.ts";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../core/extensions/types.ts";
import { currentTokenTotal } from "./accounting.js";
import { parseCommand } from "./command.js";
import { GoalCommandController } from "./commands.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import { buildGoalPrompt, buildGoalSystemPrompt } from "./prompts.js";
import { activateQueuedGoal } from "./queue.js";
import {
	type AssistantMessageLike,
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	findFinalAssistantMessage,
	formatError,
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	GoalRuntime,
	goalIdRejectionReason,
	incrementGoal,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	STATUS_KEY,
	type StatusContext,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "./settings.js";

export { completeGoalArguments } from "./command.js";

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

const EXPERIMENTAL_GOALS_WARNING =
	"Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

/**
 * UI/session capabilities the goal feature needs from its host. InteractiveMode
 * configures these (footer status + dialogs); before that, notifications and
 * status writes are no-ops and confirms deny, matching "no UI attached".
 */
export interface GoalFeatureDeps {
	/** Current AgentSession (changes on session replacement). */
	getSession?: () => AgentSession | undefined;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	confirm?: (title: string, message: string) => Promise<boolean>;
	/** Footer status for the "goal" key (undefined clears it). */
	setStatus?: (text: string | undefined) => void;
	/** Override for the pi-goal.json settings file path (tests). */
	settingsPath?: string;
}

export class GoalFeature {
	private deps: GoalFeatureDeps;
	private readonly runtime: GoalRuntime;
	private readonly commands: GoalCommandController;
	readonly tools: ToolDefinition[];

	constructor(deps: GoalFeatureDeps = {}) {
		this.deps = deps;
		this.runtime = new GoalRuntime(this.createHost());
		this.commands = new GoalCommandController(this.runtime);
		this.tools = this.createTools();
	}

	/** Merge new host capabilities (InteractiveMode (re)configures on startup). */
	configure(deps: GoalFeatureDeps): void {
		this.deps = { ...this.deps, ...deps };
	}

	get experimentalGoalsEnabled(): boolean {
		return this.runtime.settings.experimental.goals;
	}

	/**
	 * StatusContext equivalent of the old extension ctx: session-derived state
	 * plus the UI primitives injected by the host. Undefined when no session is
	 * bound (callers no-op, same as an unloaded extension).
	 */
	private makeCtx(): StatusContext | undefined {
		const session = this.deps.getSession?.();
		if (!session) return undefined;
		const notify = this.deps.notify ?? (() => {});
		const confirm = this.deps.confirm ?? (() => Promise.resolve(false));
		const setStatus = this.deps.setStatus ?? (() => {});
		return {
			cwd: session.sessionManager.getCwd(),
			ui: {
				confirm: (title: string, message: string) => confirm(title, message),
				notify: (message: string, level?: "info" | "warning" | "error") => notify(message, level),
				setStatus: (_key: string, value: string | undefined) => setStatus(value),
			},
			isIdle: () => session.isIdle,
			hasPendingMessages: () => session.pendingMessageCount > 0,
			abort: () => {
				void session.abort();
			},
			sessionManager: session.sessionManager,
		};
	}

	/**
	 * Adapter for the runtime's `pi` surface. All methods delegate to the
	 * current session at call time and are fire-and-forget (the old ExtensionAPI
	 * returned void and reported delivery failures through the error listener;
	 * here they go to the host's notify).
	 */
	private createHost(): ExtensionAPI {
		const feature = this;
		const notifyError = (prefix: string, error: unknown) => {
			feature.deps.notify?.(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
		};
		const host = {
			sendUserMessage(
				content: Parameters<AgentSession["sendUserMessage"]>[0],
				options?: { deliverAs?: "steer" | "followUp" },
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session.sendUserMessage(content, options).catch((error) => notifyError("Goal prompt failed", error));
			},
			sendMessage(
				message: Parameters<AgentSession["sendCustomMessage"]>[0],
				options?: Parameters<AgentSession["sendCustomMessage"]>[1],
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session.sendCustomMessage(message, options).catch((error) => notifyError("Goal message failed", error));
			},
			appendEntry(customType: string, data?: unknown) {
				feature.deps.getSession?.()?.appendCustomEntry(customType, data);
			},
			getActiveTools(): string[] {
				return feature.deps.getSession?.()?.getActiveToolNames() ?? [];
			},
			setActiveTools(toolNames: string[]) {
				feature.deps.getSession?.()?.setActiveToolsByName(toolNames);
			},
		};
		return host as unknown as ExtensionAPI;
	}

	private stopGoalAfterAgentEnd(
		ctx: StatusContext,
		goal: ActiveGoal,
		assistant: AssistantMessageLike,
		status: "paused" | "blocked" | "usage_limited",
	): void {
		const runtime = this.runtime;
		runtime.cancelContinuationWork();
		runtime.clearBudgetWrapUp();
		runtime.blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		runtime.activeGoal = transitionGoal(goal, status);
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);

		const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
		if (status === "paused") {
			ctx.ui.notify(`Goal paused after interruption${details}. Run /goal resume to continue.`, "warning");
			return;
		}
		if (status === "usage_limited") {
			ctx.ui.notify(
				`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
			"warning",
		);
	}

	// =========================================================================
	// /goal command (formerly pi.registerCommand("goal", ...))
	// =========================================================================

	async handleCommand(args: string): Promise<void> {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		const commands = this.commands;
		const result = parseCommand(args, {
			experimentalGoals: runtime.settings.experimental.goals,
		});
		if (typeof result === "string") {
			ctx.ui.notify(result, "warning");
			return;
		}
		if (runtime.queueFrozen) {
			if (result.kind === "show") commands.showGoal(ctx);
			else if (result.kind === "clear") commands.clearGoal(ctx);
			else commands.notifyFrozenQueue(ctx);
			return;
		}
		if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
			ctx.ui.notify("A queued goal change is waiting for Pi to settle. Retry after it finishes.", "warning");
			return;
		}

		switch (result.kind) {
			case "show":
				commands.showGoal(ctx);
				return;
			case "pause":
				commands.pauseGoal(ctx);
				return;
			case "resume":
				await commands.resumeGoal(ctx);
				return;
			case "clear":
				commands.clearGoal(ctx);
				return;
			case "edit":
				await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
				return;
			case "add":
				await commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
				return;
			case "prioritize":
				await commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
				return;
			case "drop-last":
				commands.dropLastGoal(ctx);
				return;
			case "skip":
				await commands.skipGoal(ctx);
				return;
			case "start":
				await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
				return;
		}
	}

	// =========================================================================
	// Session lifecycle (formerly pi.on("session_start"/"session_shutdown"))
	// =========================================================================

	async onSessionStart(): Promise<void> {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		const commands = this.commands;
		runtime.clearCompletionStatusTimer();
		runtime.clearStatusRefreshTimer(); // lunr
		runtime.clearContinuationTracking();
		runtime.clearPendingGoalPrompts();
		runtime.agentRunGoalId = undefined;
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		const previousToolVisibility = runtime.settings.toolVisibility;
		const settingsResult = readGoalSettings(this.deps.settingsPath);
		runtime.settings = settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
		if (settingsResult.kind === "invalid") {
			ctx.ui.notify(`pi-goal settings ignored: ${settingsResult.reason}. Using default settings.`, "warning");
		}
		if (runtime.settings.experimental.goals) {
			ctx.ui.notify(EXPERIMENTAL_GOALS_WARNING, "warning");
		}
		if (runtime.settings.toolVisibility === "after-first-goal" && previousToolVisibility === "always") {
			runtime.goalToolsUnlocked = false;
		}
		if (runtime.settings.toolVisibility === "always") {
			if (runtime.goalToolsHiddenByPolicy.size > 0) {
				try {
					runtime.restoreGoalToolsHiddenByPolicy();
				} catch (error) {
					ctx.ui.notify(`Could not restore always-visible goal tools: ${formatError(error)}`, "error");
				}
			}
			runtime.goalToolsUnlocked = true;
		}

		const loaded = loadGoalStateFromSession(ctx as unknown as Parameters<typeof loadGoalStateFromSession>[0]);
		runtime.activeGoal = loaded.goal;
		runtime.queuedGoals = loaded.queue;
		runtime.pendingQueueAction = loaded.pendingAction;
		runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
		if (runtime.queueFrozen) {
			if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
			ctx.ui.setStatus(STATUS_KEY, "queue off");
			ctx.ui.notify(
				"An experimental goal queue is frozen because experimental.goals is disabled. Re-enable it and run /reload to continue, or use /goal clear.",
				"warning",
			);
			return;
		}

		let startRestoredQueuedGoal = false;
		if (runtime.activeGoal?.status === "queued" && !runtime.pendingQueueAction) {
			runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
			startRestoredQueuedGoal = runtime.activeGoal.status === "active";
		}
		if (runtime.pendingQueueAction) await commands.dispatchPendingQueueActionIfSettled(ctx);
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active") {
				runtime.recordGoalUsage(runtime.activeGoal, ctx);
				if (runtime.limitActiveGoalForBudget(ctx, false)) return;
			}
			if (runtime.settings.toolVisibility === "after-first-goal") {
				// Registered tools are already active on an unrestricted fresh runtime.
				// If an earlier session_start handler removed them, that restrictive
				// policy wins: mark lazy visibility unlocked without widening its set.
				runtime.goalToolsUnlocked = true;
				runtime.goalToolsHiddenByPolicy.clear();
			}
			if (runtime.activeGoal.status === "active" && !runtime.goalToolsAvailable()) {
				runtime.pauseGoalForUnavailableTools(ctx, false);
				return;
			}
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			if (startRestoredQueuedGoal) {
				const restoredGoal = runtime.activeGoal;
				const sent = await runtime.sendOwnedGoalPrompt(ctx, restoredGoal.id, buildGoalPrompt(restoredGoal));
				if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
					runtime.activeGoal = transitionGoal(restoredGoal, "paused");
					runtime.blockStaleGoalToolCalls();
					runtime.persistGoal(runtime.activeGoal);
					runtime.updateStatus(ctx, runtime.activeGoal);
				}
			}
		} else {
			if (runtime.settings.toolVisibility === "after-first-goal" && !runtime.goalToolsUnlocked) {
				runtime.hideGoalToolsIfLocked();
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	onSessionShutdown(): void {
		const ctx = this.makeCtx();
		const runtime = this.runtime;
		if (runtime.activeGoal) {
			if (ctx && !runtime.queueFrozen && runtime.activeGoal.status === "active") {
				runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
			}
			runtime.persistGoal(runtime.activeGoal);
		}
		runtime.clearContinuationTracking();
		runtime.clearPendingGoalPrompts();
		runtime.agentRunGoalId = undefined;
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		this.deps.setStatus?.(undefined);
		runtime.clearCompletionStatusTimer();
		runtime.clearStatusRefreshTimer(); // lunr
	}

	// =========================================================================
	// Compaction (formerly pi.on("session_before_compact"/"session_compact"))
	// =========================================================================

	onSessionBeforeCompact(event: { willRetry?: boolean }): { cancel: true } | undefined {
		const ctx = this.makeCtx();
		if (!ctx) return undefined;
		const runtime = this.runtime;
		if (runtime.queueFrozen) return undefined;
		if (runtime.activeGoal?.status === "budget_limited") {
			if (event.willRetry === true) return { cancel: true };
			return undefined;
		}
		if (runtime.activeGoal?.status !== "active") return undefined;
		if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return undefined;
		runtime.cancelContinuationWork();
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);
		if (runtime.pendingQueueAction) return undefined;
		if (runtime.limitActiveGoalForBudget(ctx, false)) return { cancel: true };
		return undefined;
	}

	async onSessionCompact(event: { reason?: string; willRetry?: boolean }): Promise<void> {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status !== "active") {
			runtime.clearGoalRecovery();
			if (runtime.pendingQueueAction) await this.commands.dispatchPendingQueueActionIfSettled(ctx);
			return;
		}

		const restoredState = loadGoalStateFromSession(ctx as unknown as Parameters<typeof loadGoalStateFromSession>[0]);
		if (restoredState.goal?.id === runtime.activeGoal.id) {
			runtime.activeGoal = restoredState.goal;
			runtime.queuedGoals = restoredState.queue;
			runtime.pendingQueueAction = restoredState.pendingAction;
		}
		const usageRecorded = runtime.recordGoalUsage(runtime.activeGoal, ctx);
		if (usageRecorded) {
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
		}
		if (runtime.pendingQueueAction) {
			await this.commands.dispatchPendingQueueActionIfSettled(ctx);
			return;
		}
		if (!usageRecorded) return;
		if (runtime.limitActiveGoalForBudget(ctx, false)) return;

		const wasPiRetry = runtime.isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		runtime.clearGoalRecoveryForGoal(runtime.activeGoal.id);
		if (wasPiRetry) return;
		runtime.requestContinuation(runtime.activeGoal);
		// Manual compaction does not emit agent_settled. This common dispatcher is
		// therefore the narrow fallback; threshold compaction leaves the intent for
		// agent_settled when Pi is still busy.
		runtime.dispatchContinuationIfSettled(ctx);
	}

	// =========================================================================
	// Agent-run hooks (formerly pi.on("input"/"context"/"tool_call"/
	// "before_agent_start"/"tool_execution_end"/"agent_end"/"agent_settled"))
	// =========================================================================

	onInput(event: { text: string; source?: string }): { action: "handled" } | undefined {
		const runtime = this.runtime;
		if (event.source === "extension") {
			if (
				runtime.consumeCancelledContinuationPrompt(event.text) ||
				runtime.consumeStaleOwnedGoalPrompt(event.text)
			) {
				return { action: "handled" };
			}
			if (runtime.queueFrozen) return undefined;
			runtime.clearGoalRecovery();
			return undefined;
		}
		if (runtime.queueFrozen) return undefined;
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return undefined;
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
		return undefined;
	}

	onContext<T>(messages: T[]): T[] {
		const filtered = messages.filter((message) => this.runtime.keepBudgetWrapUpMessage(message));
		return filtered.length !== messages.length ? filtered : messages;
	}

	onToolCall(event: { toolName: string }): { block: true; reason: string } | undefined {
		const ctx = this.makeCtx();
		if (!ctx) return undefined;
		const runtime = this.runtime;
		if (runtime.queueFrozen) {
			if (!runtime.isGoalToolName(event.toolName)) return undefined;
			return {
				block: true,
				reason:
					"The experimental goal queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			};
		}
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			event.toolName !== "goal_complete"
		) {
			// A blocked tool result would normally trigger another model call. Abort the
			// wrap-up instead so a tool-seeking model cannot create an unbounded loop.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
			};
		}
		if (!runtime.staleGoalToolCallsBlocked) return undefined;
		if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
			runtime.clearStaleGoalToolCallBlock();
			return undefined;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	}

	onToolExecutionEnd(): void {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		if (runtime.queueFrozen) return;
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			!runtime.budgetWrapUp.delivered
		) {
			runtime.queueBudgetWrapUp(ctx, runtime.activeGoal);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);
		if (runtime.limitActiveGoalForBudget(ctx, true)) return;
		if (!runtime.goalToolsAvailable()) runtime.pauseGoalForUnavailableTools(ctx);
	}

	onBeforeAgentStart(event: { prompt: string; systemPrompt: string }): { systemPrompt: string } | undefined {
		const ctx = this.makeCtx();
		if (!ctx) return undefined;
		const runtime = this.runtime;
		if (runtime.queueFrozen) {
			runtime.agentRunGoalId = undefined;
			return undefined;
		}
		const goalPromptGoalId = runtime.consumeOwnedGoalPrompt(event.prompt);
		const continuationGoalId = goalPromptGoalId ? undefined : runtime.markContinuationStarted(event.prompt);
		const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
		const activeBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
		const activeGoalRecovery = runtime.hasActiveGoalRecovery();
		if (runtime.pendingQueueAction?.kind === "prioritize" && !activeBudgetWrapUp && !activeGoalRecovery) {
			// A turn that starts after priority intent is committed belongs to neither
			// the displaced goal nor the not-yet-activated urgent goal. Persist the
			// displaced goal's final accounting boundary so reload cannot absorb this run.
			if (!runtime.pendingQueueAction.displacedUsageFinalized) {
				if (runtime.activeGoal?.status === "active") {
					runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
				}
				runtime.pendingQueueAction.displacedUsageFinalized = true;
				if (runtime.activeGoal) {
					runtime.persistGoal(runtime.activeGoal);
					runtime.updateStatus(ctx, runtime.activeGoal);
				}
			}
			runtime.agentRunGoalId = null;
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return undefined;
		}
		if (activeBudgetWrapUp && runtime.activeGoal) {
			runtime.agentRunGoalId = runtime.activeGoal.id;
			return undefined;
		}
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal?.id
		) {
			runtime.agentRunGoalId = ownedPromptGoalId ?? runtime.activeGoal.id;
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return undefined;
		}
		if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
			runtime.agentRunGoalId = ownedPromptGoalId;
			if (runtime.activeGoal?.status === "active" && !runtime.goalToolsAvailable()) {
				runtime.pauseGoalForUnavailableTools(ctx, false);
			}
			abortCurrentTurn(ctx);
			return undefined;
		}
		if (runtime.activeGoal?.status !== "active") {
			runtime.agentRunGoalId = undefined;
			return undefined;
		}
		runtime.agentRunGoalId = runtime.activeGoal.id;
		if (!runtime.goalToolsAvailable()) {
			runtime.pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(runtime.activeGoal)}`,
		};
	}

	onAgentEnd(messages: unknown[]): void {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		if (runtime.queueFrozen) return;
		const agentRunGoalId = runtime.agentRunGoalId;
		runtime.agentRunGoalId = undefined;
		if (agentRunGoalId === null || (!runtime.canRecordGoalUsage() && !runtime.hasActiveBudgetWrapUp())) {
			return;
		}
		if (agentRunGoalId && agentRunGoalId !== runtime.activeGoal?.id) return;
		if (!runtime.activeGoal) return;
		if (runtime.activeGoal.status === "budget_limited" && runtime.budgetWrapUp?.goalId === runtime.activeGoal.id) {
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			runtime.clearBudgetWrapUp();
			return;
		}
		if (runtime.activeGoal.status !== "active") return;
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal.id
		) {
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			return;
		}

		const goalId = runtime.activeGoal.id;
		const alreadyAwaitingContinuation = runtime.hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(messages);

		if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
		runtime.recordGoalUsage(runtime.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted") {
			runtime.clearGoalRecoveryForGoal(goalId);
			this.stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (runtime.limitActiveGoalForBudget(ctx, false)) return;
				if (!runtime.goalToolsAvailable()) {
					runtime.pauseGoalForUnavailableTools(ctx);
					return;
				}
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				runtime.cancelContinuationWork();
				runtime.persistGoal(runtime.activeGoal);
				runtime.updateStatus(ctx, runtime.activeGoal);
				return;
			}
			runtime.clearGoalRecoveryForGoal(goalId);
			this.stopGoalAfterAgentEnd(
				ctx,
				runtime.activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		runtime.clearGoalRecoveryForGoal(goalId);

		if (runtime.limitActiveGoalForBudget(ctx, false)) return;
		if (!runtime.goalToolsAvailable()) {
			runtime.pauseGoalForUnavailableTools(ctx);
			return;
		}

		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);

		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (runtime.pendingQueueAction?.kind === "prioritize") return;
		runtime.requestContinuation(currentGoal);
	}

	async onAgentSettled(): Promise<void> {
		const ctx = this.makeCtx();
		if (!ctx) return;
		const runtime = this.runtime;
		if (runtime.queueFrozen) return;
		if (!runtime.pendingQueueAction) {
			runtime.dispatchContinuationIfSettled(ctx);
			return;
		}
		const dispatched = await this.commands.dispatchPendingQueueActionIfSettled(ctx);
		if (!dispatched) runtime.dispatchContinuationIfSettled(ctx);
	}

	// =========================================================================
	// Tools (formerly pi.registerTool(goal_complete / goal_blocked))
	// =========================================================================

	private createTools(): ToolDefinition[] {
		const runtime = this.runtime;
		const hasPendingSkipForGoal = (goalId: string): boolean =>
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.reason === "skip" &&
			runtime.pendingQueueAction.goalId === goalId;

		const goalCompleteTool = defineTool({
			name: GOAL_COMPLETE_TOOL,
			label: "Goal Complete",
			description:
				"Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
			promptSnippet:
				"Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
			promptGuidelines: [
				"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
				"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
				"Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
				"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
			],
			parameters: Type.Object({
				goal_id: Type.String({
					description:
						"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
				}),
				summary: Type.String({
					description:
						"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const completedGoal = runtime.activeGoal;
				const goal = completedGoal?.text ?? "unknown goal";
				const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
				const summary = typeof params.summary === "string" ? params.summary.trim() : "";

				if (!completedGoal) {
					const rejection = "Goal completion rejected: no active goal.";
					ctx.ui.notify(rejection, "warning");

					return {
						content: [{ type: "text", text: rejection }],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					};
				}
				const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
				if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
					const rejection = "Goal completion rejected: current run does not own the active goal.";
					ctx.ui.notify(rejection, "warning");
					return {
						content: [{ type: "text", text: rejection }],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					};
				}
				if (hasPendingSkipForGoal(completedGoal.id)) {
					runtime.recordGoalUsage(completedGoal, ctx);
					runtime.persistGoal(completedGoal);
					runtime.updateStatus(ctx, completedGoal);
					runtime.clearBudgetWrapUp();
					const rejection = "Goal completion rejected: goal is queued to be skipped.";
					ctx.ui.notify(rejection, "warning");
					return {
						content: [{ type: "text", text: rejection }],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
						terminate: true,
					};
				}
				const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
				if (staleGoalRejection) {
					const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
					ctx.ui.notify(rejection, "warning");
					if (completingDuringBudgetWrapUp) {
						runtime.recordGoalUsage(completedGoal, ctx);
						runtime.persistGoal(completedGoal);
						runtime.updateStatus(ctx, completedGoal);
						runtime.clearBudgetWrapUp();
					}

					return {
						content: [{ type: "text", text: rejection }],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
						terminate: completingDuringBudgetWrapUp || undefined,
					};
				}
				if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
					const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
					ctx.ui.notify(rejection, "warning");

					return {
						content: [{ type: "text", text: rejection }],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					};
				}

				const rejectionReason = !summary
					? "summary is empty"
					: isContradictoryCompletionSummary(summary)
						? "summary says the goal is not complete"
						: undefined;
				if (rejectionReason) {
					runtime.recordGoalUsage(completedGoal, ctx);
					runtime.persistGoal(completedGoal);
					runtime.updateStatus(ctx, completedGoal);
					const rejection = `Goal completion rejected: ${rejectionReason}.`;
					ctx.ui.notify(rejection, "warning");
					if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

					return {
						content: [
							{
								type: "text",
								text: rejection,
							},
						],
						details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
						terminate: completingDuringBudgetWrapUp || undefined,
					};
				}

				runtime.activeGoal = transitionGoal(completedGoal, "complete");
				runtime.recordGoalUsage(runtime.activeGoal, ctx);
				if (runtime.pendingQueueAction?.kind === "prioritize") {
					runtime.persistGoal(runtime.activeGoal);
					ctx.ui.setStatus(STATUS_KEY, "complete");
					ctx.ui.notify(`Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
					return {
						content: [{ type: "text", text: `Goal complete: ${summary}` }],
						details: {
							goal,
							goal_id: requestedGoalId,
							summary,
						} satisfies GoalCompleteDetails,
						terminate: true,
					};
				}
				if (runtime.queuedGoals.length > 0) {
					runtime.pendingQueueAction = {
						kind: "advance",
						goalId: runtime.activeGoal.id,
						reason: "complete",
						completedText: goal,
					};
					runtime.persistGoal(runtime.activeGoal);
					ctx.ui.setStatus(STATUS_KEY, "complete");
					ctx.ui.notify(`Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`, "info");
					return {
						content: [
							{
								type: "text",
								text: `Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`,
							},
						],
						details: {
							goal,
							goal_id: requestedGoalId,
							summary,
						} satisfies GoalCompleteDetails,
						terminate: true,
					};
				}
				runtime.persistGoal(runtime.activeGoal);

				ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
				runtime.clearActiveGoal(ctx);
				runtime.showCompletionStatus(ctx);
				ctx.ui.notify(`Goal complete: ${goal}`, "info");

				return {
					content: [{ type: "text", text: `Goal complete: ${summary}` }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: true,
				};
			},
		});

		const goalBlockedTool = defineTool({
			name: GOAL_BLOCKED_TOOL,
			label: "Goal Blocked",
			description:
				"Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
			promptSnippet:
				"Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
			promptGuidelines: [
				"Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
				"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
				"Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
				"Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
			],
			parameters: Type.Object({
				goal_id: Type.String({
					description: "The exact goal_id shown in the current active /goal prompt.",
				}),
				reason: Type.String({
					minLength: 1,
					maxLength: MAX_BLOCKER_REASON_LENGTH,
					description: "The specific user or external action required to unblock the goal.",
				}),
				evidence: Type.String({
					minLength: 1,
					maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
					description: "Concrete evidence from the repeated attempts that proves the impasse.",
				}),
				repeated_turns: Type.Integer({
					minimum: 3,
					description: "Number of separate turns spent trying to resolve this same blocker.",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const blockedGoal = runtime.activeGoal;
				const goal = blockedGoal?.text ?? "unknown goal";
				const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
				const reason = typeof params.reason === "string" ? params.reason.trim() : "";
				const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
				const repeatedTurns = typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
				const reject = (rejectionReason: string, terminate = false) => {
					const rejection = `goal_blocked rejected: ${rejectionReason}.`;
					ctx.ui.notify(rejection, "warning");
					return {
						content: [{ type: "text" as const, text: rejection }],
						details: {
							goal,
							goal_id: requestedGoalId,
							reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
							evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
							repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
						} satisfies GoalBlockedDetails,
						...(terminate ? { terminate: true as const } : {}),
					};
				};

				if (!blockedGoal) return reject("no active goal");
				if (!runtime.canRecordGoalUsage()) {
					return reject("current run does not own the active goal");
				}
				if (hasPendingSkipForGoal(blockedGoal.id)) {
					runtime.recordGoalUsage(blockedGoal, ctx);
					runtime.persistGoal(blockedGoal);
					runtime.updateStatus(ctx, blockedGoal);
					runtime.clearBudgetWrapUp();
					return reject("goal is queued to be skipped", true);
				}
				const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
				if (staleGoalRejection) return reject(staleGoalRejection);
				if (blockedGoal.status !== "active") {
					return reject(`goal is ${blockedGoal.status}, not active`);
				}
				if (!reason) return reject("reason is empty");
				if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
				if (!evidence) return reject("evidence is empty");
				if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
				if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
				if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

				runtime.recordGoalUsage(blockedGoal, ctx);
				runtime.cancelContinuationWork();
				runtime.clearBudgetWrapUp();
				runtime.clearGoalRecoveryForGoal(blockedGoal.id);
				runtime.blockStaleGoalToolCalls();
				runtime.activeGoal = transitionGoal(blockedGoal, "blocked");
				runtime.persistGoal(runtime.activeGoal);
				runtime.updateStatus(ctx, runtime.activeGoal);
				ctx.ui.notify(`Goal blocked: ${truncateNotification(reason)}`, "warning");

				return {
					content: [{ type: "text", text: `Goal blocked: ${reason}` }],
					details: {
						goal,
						goal_id: requestedGoalId,
						reason,
						evidence,
						repeated_turns: repeatedTurns,
					} satisfies GoalBlockedDetails,
					terminate: true,
				};
			},
		});

		return [goalCompleteTool, goalBlockedTool];
	}
}

// =========================================================================
// Process-wide singleton (the extension was a per-process factory singleton).
// =========================================================================

let currentGoalFeature: GoalFeature | undefined;

/**
 * Create (or reconfigure) the process-wide goal feature. main.ts calls this
 * with no deps so the tools always exist; InteractiveMode calls it with TUI
 * deps (footer status, dialogs, current-session getter).
 */
export function createGoalFeature(deps: GoalFeatureDeps = {}): GoalFeature {
	if (!currentGoalFeature) {
		currentGoalFeature = new GoalFeature(deps);
	} else {
		currentGoalFeature.configure(deps);
	}
	return currentGoalFeature;
}

/** Current goal feature, or undefined when none was created (tests, bare sessions). */
export function getGoalFeature(): GoalFeature | undefined {
	return currentGoalFeature;
}

/** Goal tools for the customTools assembly in main.ts. */
export function createGoalTools(): ToolDefinition[] {
	return createGoalFeature().tools;
}
