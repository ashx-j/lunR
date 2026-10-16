import { dirname, join } from "node:path";
import type { ExternalClaudeCodeCredential } from "@earendil-works/pi-ai";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

/**
 * What /logout leaves behind for a Claude subscription. Removing lunR's record does not sign out of
 * Claude Code, and the copy lunR downloaded (version 2 setup) stays on disk.
 */
export function formatClaudeSubscriptionLogoutNote(credential: ExternalClaudeCodeCredential): string {
	const signIn = "Claude Code's own sign-in is unchanged.";
	if (credential.version !== 2) return signIn;
	return `${signIn} lunR's downloaded copy (about 100 MB) stays in ${dirname(credential.command)}. Delete that folder to remove it, or run "${credential.command}" auth logout first to sign out of Claude Code too.`;
}
