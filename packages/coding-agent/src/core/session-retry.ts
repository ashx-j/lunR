/**
 * Retry after a failed request for AgentSession: which errors retry, the backoff wait before
 * the agent continues, and switching a subscription to its next pooled key when a key is used
 * up or rejected. AgentSession decides when to call these after a run and supplies the agent,
 * the retry count and events through SessionRetryHost.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { sleep } from "../utils/sleep.ts";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isAuthInvalidError, isUsageLimitError } from "./usage-limit.ts";

/** What retry needs from AgentSession. AgentSession builds one in `createRetryHost`. */
export interface SessionRetryHost {
	readonly agent: Agent;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api> | undefined;
	/** Retries of the current error so far; AgentSession's `retryAttempt` and run handling read it too. */
	retryAttempt: number;
	/** Set during the backoff wait; AgentSession's `abortRetry` and `isRetrying` read it. */
	retryAbortController: AbortController | undefined;
	emit(event: AgentSessionEvent): void;
}

/**
 * Check if an error is retryable (overloaded, rate limit, server errors).
 * Context overflow errors are NOT retryable (handled by compaction instead).
 */
export function isRetryableError(host: SessionRetryHost, message: AssistantMessage): boolean {
	// Context overflow is handled by compaction, not retry.
	if (isContextOverflow(message, host.model?.contextWindow ?? 0)) return false;
	return isRetryableAssistantError(message);
}

/**
 * Prepare a retryable error for continuation with exponential backoff.
 * @returns true if the caller should continue the agent, false otherwise
 */
export async function prepareRetry(host: SessionRetryHost, message: AssistantMessage): Promise<boolean> {
	const settings = host.settingsManager.getRetrySettings();
	if (!settings.enabled) {
		return false;
	}

	host.retryAttempt++;

	if (host.retryAttempt > settings.maxRetries) {
		// Preserve the completed attempt count so post-run handling can emit the final failure.
		host.retryAttempt--;
		return false;
	}

	const delayMs = settings.baseDelayMs * 2 ** (host.retryAttempt - 1);

	host.emit({
		type: "auto_retry_start",
		attempt: host.retryAttempt,
		maxAttempts: settings.maxRetries,
		delayMs,
		errorMessage: message.errorMessage || "Unknown error",
	});

	// Remove error message from agent state (keep in session for history)
	const messages = host.agent.state.messages;
	if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
		host.agent.state.messages = messages.slice(0, -1);
	}

	// Wait with exponential backoff (abortable)
	host.retryAbortController = new AbortController();
	try {
		await sleep(delayMs, host.retryAbortController.signal);
	} catch {
		// Aborted during sleep - emit end event so UI can clean up
		const attempt = host.retryAttempt;
		host.retryAttempt = 0;
		host.emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
		return false;
	} finally {
		host.retryAbortController = undefined;
	}

	return true;
}

/** lunr: errors that mark a subscription key dead — rotate without same-key backoff. */
export function isRotationError(message: AssistantMessage): boolean {
	const errorMessage = message.errorMessage ?? "";
	return isUsageLimitError(errorMessage) || isAuthInvalidError(errorMessage);
}

/**
 * lunr: multi-subscription rotation. When a run is about to fail final, switch
 * the provider to the next pooled key (mirrored into the credential store by
 * SubscriptionManager) and continue immediately — no backoff sleep. Returns
 * false when rotation is impossible, leaving the error as the final message.
 */
export async function tryRotateSubscriptionKey(host: SessionRetryHost, message: AssistantMessage): Promise<boolean> {
	const requestKey = host.modelRuntime.getRequestSubscriptionKey(message);
	if (!requestKey) return false;
	const providerId = requestKey.providerId;
	// A runtime --api-key override wins over auth.json in RuntimeCredentials.read(),
	// so mirroring a rotated key into the store would have no effect — skip rotation.
	if (host.modelRuntime.hasRuntimeApiKey(providerId)) return false;
	const manager = host.modelRuntime.subscriptionManager;

	const errorMessage = message.errorMessage ?? "Unknown error";
	const entry = await manager.rotateOnFailure(providerId, errorMessage, requestKey.fingerprint);
	if (!entry) return false;

	// Close out any in-flight retry indicator; a fresh key gets a fresh retry budget.
	if (host.retryAttempt > 0) {
		host.emit({ type: "auto_retry_end", success: true, attempt: host.retryAttempt });
	}
	host.retryAttempt = 0;

	// Remove error message from agent state (keep in session for history) —
	// same slice pattern as prepareRetry.
	const messages = host.agent.state.messages;
	if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
		host.agent.state.messages = messages.slice(0, -1);
	}

	host.emit({
		type: "subscription_rotation",
		providerId,
		keyName: entry.name,
		errorMessage,
	});
	return true;
}
