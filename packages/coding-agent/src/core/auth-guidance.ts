import { dirname } from "node:path";
import type { ExternalClaudeCodeCredential } from "@earendil-works/pi-ai";

const UNKNOWN_PROVIDER = "unknown";

const PROVIDER_DOCS_URL = "https://github.com/ashx-j/lunR/blob/master/packages/coding-agent/docs/providers.md";

/** `interactive` is the TUI, which has /login and /model; `print` is `-p` and other CLI output, which do not. */
export type GuidanceMode = "interactive" | "print";

/**
 * How to add a provider and pick a model, shared by every no-model/no-key message. The docs URL
 * sits on its own line so a narrow terminal does not wrap it mid-word.
 */
export function getProviderLoginHelp(mode: GuidanceMode = "interactive"): string {
	const steps =
		mode === "interactive"
			? "Run /login to add a provider, then /model to pick a model."
			: "Run lunr and use /login to add a provider, or set a provider's API key environment variable.";
	return `${steps}\nDocs:\n${PROVIDER_DOCS_URL}`;
}

export function formatNoModelsAvailableMessage(mode: GuidanceMode = "interactive"): string {
	return `No models available.\n\n${getProviderLoginHelp(mode)}`;
}

/** For when providers are ready but no model is chosen; print mode points at `--model`. */
export function formatNoModelSelectedMessage(mode: GuidanceMode = "interactive"): string {
	if (mode === "print") {
		return "No model selected.\n\nPass --model <provider>/<id>, or run lunr and pick a default with /model.";
	}
	return `No model selected.\n\n${getProviderLoginHelp()}`;
}

export function formatNoApiKeyFoundMessage(provider: string, mode: GuidanceMode = "interactive"): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp(mode)}`;
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
