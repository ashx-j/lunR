/**
 * Compaction for AgentSession: manual `/compact`, the automatic check after a run and before a
 * prompt, overflow recovery, and the compaction ceiling. AgentSession owns one SessionCompaction,
 * keeps its public compaction methods, and supplies the agent, session and events through
 * SessionCompactionHost.
 */

import type { Agent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
	estimateContextTokens as estimateRequestContextTokens,
	isContextOverflow,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "./agent-session.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	compactionCeilingFloor,
	compactionThreshold,
	estimateContextTokens,
	estimateTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { withoutDeletedHeaders } from "./provider-headers.ts";
import {
	type CompactionEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Thrown by `compact()` before any compaction event when the branch has nothing old enough to summarize. */
export class NothingToCompactError extends Error {
	constructor() {
		super("Nothing to compact (session too small)");
		this.name = "NothingToCompactError";
	}
}

/** What compaction needs from AgentSession. AgentSession builds one in `createCompactionHost`. */
export interface SessionCompactionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly systemPrompt: string;
	/** The running prompt; a correlated completion keeps queued requests from continuing after compaction. */
	readonly activePromptRun: { readonly completion?: unknown } | undefined;
	emit(event: AgentSessionEvent): void;
	getSummarizationRequestAuth(
		model: Model<Api>,
	): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
	/** Stops forwarding agent events while manual compaction rewrites the agent's messages. */
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	/** Runs `operation` as work that `drain()` waits for. */
	trackOperation<T>(operation: () => Promise<T>): Promise<T>;
	abort(): Promise<void>;
	assertCanStartWork(): void;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

/** Compaction state and runs for one AgentSession. */
export class SessionCompaction {
	private readonly host: SessionCompactionHost;
	private _manualAbortController: AbortController | undefined = undefined;
	private _manualPromise: Promise<CompactionResult> | undefined = undefined;
	private _autoAbortController: AbortController | undefined = undefined;
	/** Set after one overflow compact-and-retry. AgentSession's agent event handler clears it when a user message starts and when a reply ends without an error. */
	overflowRecoveryAttempted = false;
	/** Set when a ceiling compaction fails or is cancelled. AgentSession also sets it from the between-turn check and clears it just before a prompt's opening check. */
	ceilingFailedThisRun = false;
	/** `lastCompactedTokens`: the estimated context size the latest compaction left. Not persisted. */
	private _compactedContextTokens = 0;
	private _prefixCache: { systemPrompt: string; tools: readonly AgentTool[]; tokens: number } | undefined;

	constructor(host: SessionCompactionHost) {
		this.host = host;
	}

	/** True while a manual or automatic compaction runs. */
	get isRunning(): boolean {
		return this._autoAbortController !== undefined || this._manualAbortController !== undefined;
	}

	/** The running manual compaction, which blocks a new prompt run. */
	get manualPromise(): Promise<CompactionResult> | undefined {
		return this._manualPromise;
	}

	/** Cancels a running automatic compaction only (a correlated prompt was cancelled). */
	abortAuto(): void {
		this._autoAbortController?.abort();
	}

	private _latestCompactionResult(): CompactionResult | undefined {
		const pathEntries = this.host.sessionManager.getBranch();
		const lastEntry = pathEntries[pathEntries.length - 1];
		if (lastEntry?.type !== "compaction") return undefined;
		return {
			summary: lastEntry.summary,
			firstKeptEntryId: lastEntry.firstKeptEntryId,
			tokensBefore: lastEntry.tokensBefore,
			estimatedTokensAfter: estimateMessagesTokens(this.host.sessionManager.buildSessionContext().messages),
			details: lastEntry.details,
		};
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this.host.assertCanStartWork();
		const existing = this._latestCompactionResult();
		if (existing) return existing;
		if (this._manualPromise) return this._manualPromise;

		const promise = this.host.trackOperation(() => this._compact(customInstructions));
		this._manualPromise = promise;
		try {
			return await promise;
		} finally {
			if (this._manualPromise === promise) this._manualPromise = undefined;
		}
	}

	private async _compact(customInstructions?: string): Promise<CompactionResult> {
		await this.host.abort();
		this.host.assertCanStartWork();
		const existing = this._latestCompactionResult();
		if (existing) return existing;
		// Checks that fail before compaction_start emit no compaction events; callers report the error.
		if (!this.host.model) throw new Error(formatNoModelSelectedMessage());
		const model = this.host.model;
		const { apiKey, headers, env } = await this.host.getSummarizationRequestAuth(model);
		const pathEntries = this.host.sessionManager.getBranch();
		const preparation = prepareCompaction(
			pathEntries,
			this.host.settingsManager.getCompactionSettings(),
			model.contextWindow,
		);
		if (!preparation) throw new NothingToCompactError();
		this.host.disconnectFromAgent();
		this._manualAbortController = new AbortController();

		try {
			this.host.emit({ type: "compaction_start", reason: "manual" });

			const hook = await this._beforeCompactHook(
				preparation,
				pathEntries,
				customInstructions,
				"manual",
				false,
				this._manualAbortController.signal,
			);
			if (hook.cancelled) {
				throw new Error("Compaction cancelled");
			}
			const extensionCompaction = hook.compaction;
			const fromExtension = extensionCompaction !== undefined;

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					model,
					apiKey,
					headers,
					customInstructions,
					this._manualAbortController.signal,
					this.host.thinkingLevel,
					this.host.agent.streamFn,
					env,
					(response) => this.host.sessionManager.appendRequestUsage("compaction", response),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._manualAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const compactionResult = await this._saveCompaction(
				{ summary, firstKeptEntryId, tokensBefore, details },
				fromExtension,
				"manual",
				false,
			);
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._manualAbortController = undefined;
			this.host.reconnectToAgent();
		}
	}

	/**
	 * Runs the session_before_compact handlers. `cancelled` when one cancels; `compaction` when one
	 * supplies the summary itself. Without handlers it returns at once.
	 */
	private async _beforeCompactHook(
		preparation: CompactionPreparation,
		branchEntries: SessionEntry[],
		customInstructions: string | undefined,
		reason: "manual" | "overflow" | "threshold",
		willRetry: boolean,
		signal: AbortSignal,
	): Promise<{ cancelled: boolean; compaction?: CompactionResult }> {
		if (!this.host.extensionRunner.hasHandlers("session_before_compact")) return { cancelled: false };
		const result = (await this.host.extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions,
			reason,
			willRetry,
			signal,
		})) as SessionBeforeCompactResult | undefined;
		if (result?.cancel) return { cancelled: true };
		return { cancelled: false, compaction: result?.compaction };
	}

	/**
	 * Saves a compaction summary to the session, rebuilds the agent's messages from it, records the
	 * compacted size and tells session_compact handlers. Returns the result compaction_end reports.
	 */
	private async _saveCompaction(
		saved: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown },
		fromExtension: boolean,
		reason: "manual" | "overflow" | "threshold",
		willRetry: boolean,
	): Promise<CompactionResult> {
		const { summary, firstKeptEntryId, tokensBefore, details } = saved;
		this.host.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
		const newEntries = this.host.sessionManager.getEntries();
		const sessionContext = this.host.sessionManager.buildSessionContext();
		this.host.agent.state.messages = sessionContext.messages;
		const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
		this._recordCompactedSize(estimatedTokensAfter);

		// Get the saved compaction entry for the extension event
		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;

		if (this.host.extensionRunner && savedCompactionEntry) {
			await this.host.extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
				reason,
				willRetry,
			});
		}

		return { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details };
	}

	/**
	 * Request auth for an automatic compaction. Undefined when the built-in stream has no API key,
	 * so the compaction is skipped without events.
	 */
	private async _autoCompactionAuth(
		model: Model<Api>,
	): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | undefined> {
		if (this.host.agent.streamFn === streamSimple) {
			const authResult = await this.host.modelRuntime.getAuth(model);
			if (!authResult?.auth.apiKey) return undefined;
			return {
				apiKey: authResult.auth.apiKey,
				headers: withoutDeletedHeaders(authResult.auth.headers),
				env: authResult.env,
			};
		}
		return this.host.getSummarizationRequestAuth(model);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abort(): void {
		this._manualAbortController?.abort();
		this._autoAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.host.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.host.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.host.model &&
			assistantMessage.provider === this.host.model.provider &&
			assistantMessage.model === this.host.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.host.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error, or reported usage exceeded
		// the configured window. A successful response over the configured window should compact
		// but must not retry: the assistant answer already completed and agent.continue() cannot
		// continue from an assistant message.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this.runAutoCompaction("overflow", false);
			}

			if (this.overflowRecoveryAttempted) {
				this.host.emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this.overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.host.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.host.agent.state.messages = messages.slice(0, -1);
			}
			return await this.runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.host.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (
			shouldCompact(
				contextTokens,
				contextWindow,
				settings,
				this.prefixTokens(settings),
				this.lastCompactedTokens(settings),
			)
		) {
			const previousCompactionId = compactionEntry?.id;
			const continued = await this.runAutoCompaction("threshold", false);
			if (
				settings.ceilingTokens !== undefined &&
				getLatestCompactionEntry(this.host.sessionManager.getBranch())?.id === previousCompactionId
			) {
				this.ceilingFailedThisRun = true;
			}
			return continued;
		}
		return false;
	}

	/**
	 * System prompt and tool schema tokens, which a compacted context still carries. Only the ceiling
	 * needs them. Cached on the prompt string and tools array, since counting a 65k-character prefix
	 * takes 1 to 3 ms and the ceiling checks it every tool turn.
	 */
	prefixTokens(settings: CompactionSettings): number {
		if (!settings.ceilingTokens) return 0;
		const systemPrompt = this.host.systemPrompt;
		const tools = this.host.agent.state.tools;
		const cached = this._prefixCache;
		if (cached?.systemPrompt === systemPrompt && cached.tools === tools) return cached.tokens;
		const tokens = estimateRequestContextTokens({ systemPrompt, tools, messages: [] }).tokens;
		this._prefixCache = { systemPrompt, tools, tokens };
		return tokens;
	}

	/**
	 * The configured compaction ceiling and the token count this session compacts at (the raised
	 * ceiling, capped by the window threshold), when a ceiling is set.
	 */
	getCeiling(): { configured: number; effective: number; keptTokens?: number } | undefined {
		const settings = this.host.settingsManager.getCompactionSettings();
		if (settings.ceilingTokens === undefined) return undefined;
		const effective = compactionThreshold(
			this.host.model?.contextWindow ?? 0,
			settings,
			this.prefixTokens(settings),
			this.lastCompactedTokens(settings),
		);
		const { keptTokens } = this.getCeilingFloor();
		return { configured: settings.ceilingTokens, effective, ...(keptTokens ? { keptTokens } : {}) };
	}

	/**
	 * The lowest ceiling this session would use, whatever the setting (`compactionCeilingFloor`), and
	 * `keptTokens` when what the last compaction kept, not the estimate, sets it. That lasts until the
	 * next compaction keeps less.
	 */
	getCeilingFloor(): { floor: number; keptTokens?: number } {
		const settings = { ...this.host.settingsManager.getCompactionSettings(), ceilingTokens: 1 };
		const contextWindow = this.host.model?.contextWindow ?? 0;
		const prefix = this.prefixTokens(settings);
		const kept = this.lastCompactedTokens(settings);
		const floor = compactionCeilingFloor(contextWindow, settings, prefix, kept);
		return floor > compactionCeilingFloor(contextWindow, settings, prefix) ? { floor, keptTokens: kept } : { floor };
	}

	/**
	 * The estimated size of the context the latest compaction in this process left (system prompt and
	 * tools plus the summary and kept messages), recorded when it succeeded. An estimate, like the
	 * mid-prompt check it feeds, so a retried, aborted or zero-usage request can't change it. 0 without
	 * a ceiling or before the first compaction, so behavior without a ceiling is unchanged.
	 */
	lastCompactedTokens(settings: CompactionSettings): number {
		return settings.ceilingTokens ? this._compactedContextTokens : 0;
	}

	/** Records `lastCompactedTokens` after a compaction rebuilt the context from `messages`. */
	private _recordCompactedSize(messagesTokens: number): void {
		const settings = this.host.settingsManager.getCompactionSettings();
		this._compactedContextTokens = settings.ceilingTokens ? this.prefixTokens(settings) + messagesTokens : 0;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	async runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		if (!this.host.model || this._manualAbortController || this._autoAbortController) return false;
		const settings = this.host.settingsManager.getCompactionSettings();
		let started = false;

		try {
			const auth = await this._autoCompactionAuth(this.host.model);
			if (!auth) return false;
			const { apiKey, headers, env } = auth;

			const pathEntries = this.host.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings, this.host.model.contextWindow);
			if (!preparation) {
				return false;
			}

			this.host.emit({ type: "compaction_start", reason });
			this._autoAbortController = new AbortController();
			started = true;

			const hook = await this._beforeCompactHook(
				preparation,
				pathEntries,
				undefined,
				reason,
				willRetry,
				this._autoAbortController.signal,
			);
			if (hook.cancelled) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}
			const extensionCompaction = hook.compaction;
			const fromExtension = extensionCompaction !== undefined;

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					this.host.model,
					apiKey,
					headers,
					undefined,
					this._autoAbortController.signal,
					this.host.thinkingLevel,
					this.host.agent.streamFn,
					env,
					(response) => this.host.sessionManager.appendRequestUsage("compaction", response),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoAbortController.signal.aborted) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			const result = await this._saveCompaction(
				{ summary, firstKeptEntryId, tokensBefore, details },
				fromExtension,
				reason,
				willRetry,
			);
			this.host.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.host.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.host.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Only ordinary runs continue queued requests after successful compaction.
			// Correlated completion must settle before those requests begin.
			return !this.host.activePromptRun?.completion && this.host.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoAbortController = undefined;
		}
	}
}
