/**
 * /login flow for interactive mode: provider listing, auth-type and provider selectors,
 * the Anthropic ToS gate and the custom endpoint wizard. InteractiveMode supplies the
 * UI and session through LoginFlowHost; the credential dialogs stay in InteractiveMode.
 */

import * as path from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { hasGrokCliXaiAuth } from "../../core/grok-cli-auth.ts";
import {
	isValidProviderBaseUrl,
	parseModelIds,
	slugifyProviderId,
	upsertCustomProvider,
} from "../../core/model-config-writer.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";

// lunr: pre-connection ToS disclaimer for Anthropic subscription (OAuth) accounts.
const ANTHROPIC_TOS_DISCLAIMER =
	"Connecting an Anthropic subscription through Claude Code may be subject to Anthropic's Terms of Service (https://www.anthropic.com/legal/consumer-terms). Claude Code authenticates each lunR generation; lunR keeps its own tools and history. Continue?";

/** What the login flow needs from InteractiveMode. InteractiveMode builds one in `createLoginFlowHost`. */
export interface LoginFlowHost {
	readonly session: AgentSession;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Continue/Cancel dialog that defaults to Cancel. */
	confirmDisclaimer(title: string, message: string): Promise<boolean>;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionInput(title: string, placeholder?: string): Promise<string | undefined>;
	requestRender(): void;
	showLoginDialog(providerId: string, providerName: string): Promise<void>;
	showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
	showAmbientAuthDialog(providerOption: AuthSelectorProvider): void;
	completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: AgentSession["model"],
		overrides?: { actionLabel?: string; savedNote?: string },
	): Promise<void>;
	updateAvailableProviderCount(): Promise<void>;
	invalidateFooter(): void;
	updateEditorBorderColor(): void;
	/** Opens /model when the session still has no model and one is available to pick. */
	openModelSelectorIfUnset(): Promise<void>;
}

/**
 * Lists every provider login option, one entry per provider and auth type, sorted by name.
 * Pass `authType` to keep only subscription (`oauth`) or API-key providers.
 */
export function getLoginProviderOptions(
	modelRuntime: Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus" | "isUsingOAuth">,
	authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of modelRuntime.getProviders()) {
		const authStatus = modelRuntime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
			});
		}
		if ((!authType || authType === "api_key") && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

function findLoginProviderOptions(host: LoginFlowHost, providerRef: string): AuthSelectorProvider[] {
	const normalizedProviderRef = providerRef.trim().toLowerCase();
	if (!normalizedProviderRef) {
		return [];
	}

	return getLoginProviderOptions(host.session.modelRuntime).filter(
		(provider) =>
			provider.id.toLowerCase() === normalizedProviderRef || provider.name.toLowerCase() === normalizedProviderRef,
	);
}

/** Runs `/login [provider]`: no argument opens the auth-type menu, an exact match starts that login. */
export async function handleLoginCommand(host: LoginFlowHost, providerRef?: string): Promise<void> {
	await host.session.modelRuntime.getAvailable();
	if (!providerRef) {
		showLoginAuthTypeSelector(host);
		return;
	}

	const providerOptions = findLoginProviderOptions(host, providerRef);
	if (providerOptions.length === 1) {
		await startProviderLogin(host, providerOptions[0]!);
		return;
	}

	if (providerOptions.length > 1) {
		const providerIds = new Set(providerOptions.map((provider) => provider.id));
		if (providerIds.size === 1) {
			showLoginAuthTypeSelector(host, providerOptions);
			return;
		}
	}

	showLoginProviderSelector(host, undefined, providerRef);
}

/** Starts the login for one provider option, behind the Anthropic ToS gate for Anthropic subscriptions. */
export async function startProviderLogin(host: LoginFlowHost, providerOption: AuthSelectorProvider): Promise<void> {
	// lunr: gate Anthropic OAuth (subscription) login with a ToS disclaimer.
	if (providerOption.id === "anthropic" && providerOption.authType === "oauth") {
		const confirmed = await host.confirmDisclaimer("Anthropic Terms of Service", ANTHROPIC_TOS_DISCLAIMER);
		if (!confirmed) {
			host.showStatus("Login cancelled.");
			return;
		}
	}
	if (providerOption.authType === "oauth") {
		if (providerOption.id === "xai" && hasGrokCliXaiAuth()) {
			const choice = await host.showExtensionSelector("xAI SuperGrok is already signed in via Grok CLI.", [
				"Use existing Grok CLI login",
				"Sign in again",
			]);
			if (choice === undefined) return;
			if (choice === "Use existing Grok CLI login") {
				try {
					const imported = await host.session.modelRuntime.importGrokCliXaiAuth();
					if (!imported) {
						host.showError("Could not read the Grok CLI SuperGrok session. Run /login xai again.");
						return;
					}
					await host.completeProviderAuthentication(
						providerOption.id,
						providerOption.name,
						"oauth",
						host.session.model,
						{ actionLabel: "Imported Grok CLI login", savedNote: "Using ~/.grok/auth.json" },
					);
				} catch (error: unknown) {
					host.showError(
						`Failed to import Grok CLI login: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
		}
		await host.showLoginDialog(providerOption.id, providerOption.name);
	} else if (providerOption.method?.login) {
		await host.showApiKeyLoginDialog(providerOption.id, providerOption.name);
	} else {
		host.showAmbientAuthDialog(providerOption);
	}
}

/**
 * Shows the "Select authentication method" menu. Without `providerOptions` it is the top-level
 * /login menu (account, API key, custom endpoint); with them it picks an auth type for that provider.
 */
export function showLoginAuthTypeSelector(host: LoginFlowHost, providerOptions?: AuthSelectorProvider[]): void {
	const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
	const oauthLoginLabel =
		oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
	const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
	const apiKeyLabel = "Sign in with an API key";
	const availableAuthTypes = providerOptions
		? new Set(providerOptions.map((provider) => provider.authType))
		: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
	const options: string[] = [];
	if (availableAuthTypes.has("oauth")) {
		options.push(subscriptionLabel);
	}
	if (availableAuthTypes.has("api_key")) {
		options.push(apiKeyLabel);
	}
	// lunr: custom-endpoint wizard is only offered from the top-level auth-type menu
	// (no provider chosen yet), not when re-authenticating a specific provider.
	const customProviderLabel = "Connect a custom API endpoint…";
	if (!providerOptions) {
		options.push(customProviderLabel);
	}

	if (options.length === 0) {
		host.showStatus("No login methods available.");
		return;
	}

	if (providerOptions && options.length === 1) {
		const providerOption = providerOptions[0];
		if (providerOption) {
			void startProviderLogin(host, providerOption);
		}
		return;
	}

	const title = providerOptions?.[0]
		? `Select authentication method for ${providerOptions[0].name}:`
		: "Select authentication method:";
	host.showSelector((done) => {
		const selector = new ExtensionSelectorComponent(
			title,
			options,
			(option) => {
				done();
				// lunr: intercept before the oauth/api_key label mapping below.
				if (option === customProviderLabel) {
					void showCustomProviderWizard(host).catch((error: unknown) =>
						host.showError(error instanceof Error ? error.message : String(error)),
					);
					return;
				}
				const authType = option === subscriptionLabel ? "oauth" : "api_key";
				if (providerOptions) {
					const providerOption = providerOptions.find((provider) => provider.authType === authType);
					if (providerOption) {
						void startProviderLogin(host, providerOption);
					}
					return;
				}
				showLoginProviderSelector(host, authType);
			},
			() => {
				done();
				host.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

/**
 * Shows the searchable provider list, filtered to subscription (`oauth`) or API-key providers when
 * `authType` is set. Escape returns to the auth-type menu when filtered, otherwise to the editor.
 */
export function showLoginProviderSelector(
	host: LoginFlowHost,
	authType?: AuthSelectorProvider["authType"],
	initialSearchInput?: string,
): void {
	const providerOptions = getLoginProviderOptions(host.session.modelRuntime, authType);
	if (providerOptions.length === 0) {
		const message =
			authType === "oauth"
				? "No subscription providers available."
				: authType === "api_key"
					? "No API key providers available."
					: "No login providers available.";
		host.showStatus(message);
		return;
	}

	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			"login",
			providerOptions,
			async (providerId, selectedAuthType) => {
				done();

				const providerOption = providerOptions.find(
					(provider) => provider.id === providerId && provider.authType === selectedAuthType,
				);
				if (!providerOption) {
					return;
				}

				await startProviderLogin(host, providerOption);
			},
			() => {
				done();
				if (authType) {
					showLoginAuthTypeSelector(host);
				} else {
					host.requestRender();
				}
			},
			initialSearchInput,
		);
		return { component: selector, focus: selector };
	});
}

// lunr: /login "Connect a custom API endpoint…" wizard. Writes the provider to
// models.json via upsertCustomProvider, then stores the key through the standard
// api_key login route (auth.json) once reloadConfig has composed the provider.
// Ends in /model when no model got selected. Callers report a rejection with showError.
export async function showCustomProviderWizard(host: LoginFlowHost): Promise<void> {
	const cancelled = () => host.showStatus("Custom provider setup cancelled.");

	const nameInput = await host.showExtensionInput("Custom provider — display name:", "My Provider");
	const name = nameInput?.trim();
	if (!name) {
		cancelled();
		return;
	}
	const existingIds = host.session.modelRuntime.getProviders().map((provider) => provider.id);
	const providerId = slugifyProviderId(name, existingIds);

	const baseUrlInput = await host.showExtensionInput(`Base URL for ${name}:`, "https://api.example.com/v1");
	if (baseUrlInput === undefined) {
		cancelled();
		return;
	}
	const baseUrl = baseUrlInput.trim();
	if (!isValidProviderBaseUrl(baseUrl)) {
		host.showError(`Invalid base URL "${baseUrl}" — it must start with http:// or https://.`);
		return;
	}

	const api = await host.showExtensionSelector(`API protocol for ${name}:`, [
		"openai-completions",
		"openai-responses",
		"anthropic-messages",
		"google-generative-ai",
	]);
	if (!api) {
		cancelled();
		return;
	}

	const modelIdsInput = await host.showExtensionInput(
		`Model IDs exposed by ${name} (comma-separated):`,
		"model-a, model-b",
	);
	if (modelIdsInput === undefined) {
		cancelled();
		return;
	}
	const modelIds = parseModelIds(modelIdsInput);
	if (modelIds.length === 0) {
		host.showError("At least one model ID is required.");
		return;
	}

	const apiKeyInput = await host.showExtensionInput(`API key for ${name}:`);
	const apiKey = apiKeyInput?.trim();
	if (!apiKey) {
		cancelled();
		return;
	}

	const modelsJsonPath = path.join(getAgentDir(), "models.json");
	try {
		await upsertCustomProvider(modelsJsonPath, providerId, {
			name,
			baseUrl,
			api,
			models: modelIds.map((id) => ({ id })),
		});
		await host.session.modelRuntime.reloadConfig();
	} catch (error: unknown) {
		host.showError(`Failed to add custom provider: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	try {
		// The composed provider's fabricated apiKey.login persists via credentials.modify
		// (auth.json) — the same storage route showApiKeyLoginDialog uses.
		await host.session.modelRuntime.login(providerId, "api_key", {
			prompt: () => Promise.resolve(apiKey),
			notify: () => {},
		});
	} catch (error: unknown) {
		await host.updateAvailableProviderCount();
		host.showError(
			`Custom provider '${name}' was added to models.json, but saving its API key failed: ${error instanceof Error ? error.message : String(error)}. Use /login to store a key.`,
		);
		return;
	}

	await host.updateAvailableProviderCount();
	host.invalidateFooter();
	host.updateEditorBorderColor();

	const refineNote = `Refine contextWindow/cost by editing ${modelsJsonPath}.`;
	const modelCount = modelIds.length;
	if (modelCount === 1) {
		const modelId = modelIds[0];
		const model = modelId ? host.session.modelRuntime.getModel(providerId, modelId) : undefined;
		if (model) {
			const choice = await host.showExtensionSelector(
				`Custom provider '${name}' added. Select ${model.id} as the active model?`,
				["Select model", "Skip"],
			);
			if (choice === "Select model") {
				try {
					await host.session.setModel(model);
					host.showStatus(`Custom provider '${name}' added (1 model). Selected ${model.id}. ${refineNote}`);
					return;
				} catch (error: unknown) {
					host.showError(
						`Selecting ${model.id} failed: ${error instanceof Error ? error.message : String(error)}. Use /model to select a model.`,
					);
				}
			}
		}
	}
	host.showStatus(
		`Custom provider '${name}' added (${modelCount} model${modelCount === 1 ? "" : "s"}). ${refineNote}`,
	);
	await host.openModelSelectorIfUnset();
}
