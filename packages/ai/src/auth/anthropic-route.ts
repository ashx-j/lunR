import type { ModelsStreamTransforms } from "../models.ts";
import type { AssistantMessage, StreamOptions } from "../types.ts";
import { ModelsError } from "./resolve.ts";
import type { AuthResult, Credential } from "./types.ts";

export const ANTHROPIC_SETUP_REQUIRED =
	"Anthropic subscription authentication now requires Claude Code. Run /login anthropic and choose the subscription option. Direct OAuth tokens are no longer supported.";

/** Connections older than version 3 lack Claude Code's model routes and windows, so they cannot serve requests. */
export const CLAUDE_CODE_UPDATE_REQUIRED =
	"This Claude subscription connection was made with an older lunR setup. Run /login anthropic to update it.";

/**
 * Claude Code release that lunR downloads and runs for Anthropic subscriptions. History replay and
 * request-body overrides are version-sensitive, so a version change needs a fresh live qualification.
 * `utils/claude-code-release.ts` holds the matching download hashes; this module stays browser-safe.
 */
export const CLAUDE_CODE_VERSION = "2.1.310";

/**
 * Note for a saved Claude subscription that runs an older Claude Code than the pinned release. Its model
 * list came from that release's picker, so newer models only appear after /login anthropic. Undefined when
 * the connection is current or is not a Claude Code subscription.
 */
export function claudeCodeUpdateNote(credential: Credential | undefined): string | undefined {
	if (credential?.type !== "external_claude_code" || credential.version !== 3) return undefined;
	const version = /[\\/]claude-code[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(credential.command)?.[1];
	if (!version || version === CLAUDE_CODE_VERSION) return undefined;
	return `Claude subscription models come from Claude Code ${version}. Run /login anthropic to update to ${CLAUDE_CODE_VERSION} and get newer models.`;
}

const CLAUDE_RELEASE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/;

/**
 * Catalog Claude models newer than the newest one the saved subscription login lists in the same family
 * (opus, sonnet, haiku, ...). The login's list comes from the Claude Code picker at login time, so these
 * need /login anthropic before the picker shows them. Dated snapshot ids are ignored. Empty when the
 * credential is not a Claude Code subscription.
 */
export function claudeModelsNewerThanLogin(
	credential: Credential | undefined,
	catalog: readonly { id: string }[],
): string[] {
	if (credential?.type !== "external_claude_code") return [];
	const release = (id: string) => {
		const match = CLAUDE_RELEASE.exec(id);
		return match ? { family: match[1], version: Number(match[2]) * 100 + Number(match[3] ?? 0) } : undefined;
	};
	const newest = new Map<string, number>();
	for (const offered of credential.models ?? []) {
		const listed = release(offered.id);
		if (listed) newest.set(listed.family, Math.max(listed.version, newest.get(listed.family) ?? 0));
	}
	return catalog.flatMap(({ id }) => {
		const model = release(id);
		const listed = model && newest.get(model.family);
		return model && listed !== undefined && model.version > listed ? [id] : [];
	});
}

/**
 * Diagnostic type the subscription bridge adds to an assistant message whose history was too large for
 * Claude Code's settings file. Such requests replay the history through stdin, which is not prompt-cached.
 */
export const CLAUDE_CODE_HISTORY_REPLAYED = "claude_code_history_replayed";

export const CLAUDE_CODE_HISTORY_REPLAYED_NOTE =
	"This conversation is over 2 MiB, so Claude Code can no longer read its history from the prompt cache. Each request now sends it uncached, which is slower and uses more of your plan. Run /compact to shrink it.";

/** Whether the bridge sent this reply's history through the uncached replay. */
export function claudeCodeHistoryReplayed(message: AssistantMessage | undefined): boolean {
	return !!message?.diagnostics?.some((diagnostic) => diagnostic.type === CLAUDE_CODE_HISTORY_REPLAYED);
}

export function isAnthropicOAuthToken(value: string | undefined): boolean {
	return !!value && (value.includes("sk-ant-oat") || value.startsWith("sk-ant-oauth"));
}

export function anthropicRequestRoute(
	provider: string,
	resolution: AuthResult,
	options: (StreamOptions & ModelsStreamTransforms) | undefined,
): Pick<StreamOptions, "apiKey" | "externalClaudeCode"> {
	if (provider !== "anthropic") return { apiKey: options?.apiKey ?? resolution.auth.apiKey };
	const apiKey = options?.apiKey ?? resolution.auth.apiKey;
	if (isAnthropicOAuthToken(apiKey)) throw new ModelsError("auth", ANTHROPIC_SETUP_REQUIRED);
	if (resolution.auth.externalClaudeCode && !apiKey) {
		if (
			Object.keys(options?.headers ?? {}).length ||
			options?.onPayload ||
			options?.onResponse ||
			options?.transformHeaders ||
			options?.env ||
			Object.keys(resolution.auth.headers ?? {}).length
		) {
			throw new ModelsError(
				"auth",
				"Claude Code subscription requests do not support custom headers, payload hooks, or environment overrides",
			);
		}
		return { externalClaudeCode: resolution.auth.externalClaudeCode };
	}
	return { apiKey };
}
