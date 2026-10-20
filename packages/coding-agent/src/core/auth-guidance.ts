import { dirname } from "node:path";
import type { ExternalClaudeCodeCredential } from "@earendil-works/pi-ai";

const UNKNOWN_PROVIDER = "unknown";

/** Two-line pointer to /login, /model and the provider docs, shared by every no-model/no-key message. */
export function getProviderLoginHelp(): string {
	return [
		"Run /login to add a provider, then /model to pick a model.",
		"Docs: https://github.com/ashx-j/lunR/blob/master/packages/coding-agent/docs/providers.md",
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

/**
 * What /logout leaves behind for a Claude subscription. Removing lunR's record does not sign out of
 * Claude Code, and the copy lunR downloaded (version 2 setup onward) stays on disk.
 */
export function formatClaudeSubscriptionLogoutNote(credential: ExternalClaudeCodeCredential): string {
	const signIn = "Claude Code's own sign-in is unchanged.";
	if (credential.version === 1) return signIn;
	return `${signIn} lunR's downloaded copy (about 100 MB) stays in ${dirname(credential.command)}. Delete that folder to remove it, or run "${credential.command}" auth logout first to sign out of Claude Code too.`;
}
