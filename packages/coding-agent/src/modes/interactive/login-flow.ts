/**
 * /login and /logout for interactive mode: provider listing, auth-type and provider selectors,
 * the Anthropic ToS gate, the custom endpoint wizard, the credential dialogs (OAuth, API key,
 * ambient auth) and the model pick after a login. InteractiveMode supplies the UI and session
 * through LoginFlowHost.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Api, AuthEvent, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import { getAgentDir, getAuthPath, getDocsPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { formatClaudeSubscriptionLogoutNote } from "../../core/auth-guidance.ts";
import { hasGrokCliXaiAuth } from "../../core/grok-cli-auth.ts";
import {
	isValidProviderBaseUrl,
	parseModelIds,
	slugifyProviderId,
	upsertCustomProvider,
} from "../../core/model-config-writer.ts";
import { defaultModelPerProvider, findSignedOutScopePatterns } from "../../core/model-resolver.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { theme } from "./theme/theme.ts";

// lunr: pre-connection ToS disclaimer for Anthropic subscription (OAuth) accounts.
const ANTHROPIC_TOS_DISCLAIMER =
	"Connecting an Anthropic subscription through Claude Code may be subject to Anthropic's Terms of Service (https://www.anthropic.com/legal/consumer-terms). Claude Code authenticates each lunR generation; lunR keeps its own tools and history. Continue?";

/** What the login flow needs from InteractiveMode. InteractiveMode builds one in `createLoginFlowHost`. */
export interface LoginFlowHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	/** Holds the editor; credential dialogs replace it there and put `editor` back when done. */
	readonly editorContainer: Container;
	readonly editor: Component;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Continue/Cancel dialog that defaults to Cancel. */
	confirmDisclaimer(title: string, message: string): Promise<boolean>;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionInput(title: string, placeholder?: string): Promise<string | undefined>;
	requestRender(): void;
	/** Warns when the given (or current) Anthropic model would use subscription auth it cannot. */
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api>): Promise<void>;
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
					await completeProviderAuthentication(
						host,
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
		await showLoginDialog(host, providerOption.id, providerOption.name);
	} else if (providerOption.method?.login) {
		await showApiKeyLoginDialog(host, providerOption.id, providerOption.name);
	} else {
		showAmbientAuthDialog(host, providerOption);
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
// An empty key writes a placeholder for keyless servers. Ends in /model when no model got
// selected, unless the user chose Skip. Callers report a rejection with showError.
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

	// A bad URL asks again; only Escape leaves the wizard.
	let baseUrlTitle = `Base URL for ${name}:`;
	let baseUrl: string;
	for (;;) {
		const baseUrlInput = await host.showExtensionInput(baseUrlTitle, "https://api.example.com/v1");
		if (baseUrlInput === undefined) {
			cancelled();
			return;
		}
		baseUrl = baseUrlInput.trim();
		if (isValidProviderBaseUrl(baseUrl)) break;
		baseUrlTitle = `Base URL for ${name} (must start with http:// or https://):`;
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

	const apiKeyInput = await host.showExtensionInput(`API key for ${name} (leave empty if the server needs none):`);
	if (apiKeyInput === undefined) {
		cancelled();
		return;
	}
	const apiKey = apiKeyInput.trim();

	const modelsJsonPath = path.join(getAgentDir(), "models.json");
	try {
		await upsertCustomProvider(modelsJsonPath, providerId, {
			name,
			baseUrl,
			api,
			// Models need some auth to show in /model; keyless local servers ignore this placeholder.
			...(apiKey ? {} : { apiKey: "none" }),
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
		if (apiKey) {
			await host.session.modelRuntime.login(providerId, "api_key", {
				prompt: () => Promise.resolve(apiKey),
				notify: () => {},
			});
		}
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
			if (choice === "Skip") {
				host.showStatus(`Custom provider '${name}' added (1 model). ${refineNote}`);
				return;
			}
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

/** The placeholder model a session holds before any real model is selected. */
export function isUnknownModel(model: Model<Api> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

async function getLogoutProviderOptions(host: LoginFlowHost): Promise<AuthSelectorProvider[]> {
	// lunr: providers with a multi-key pool list one entry per subscription plus an
	// "all subscriptions" entry, encoding the target as "<providerId>#<subId|all>".
	const options: AuthSelectorProvider[] = [];
	for (const { providerId, type: credentialType } of await host.session.modelRuntime.listCredentials()) {
		const type = credentialType === "external_claude_code" ? "oauth" : credentialType;
		const providerName = host.session.modelRuntime.getProvider(providerId)?.name ?? providerId;
		const name = credentialType === "external_claude_code" ? `${providerName} (Claude subscription)` : providerName;
		const status = { type, source: "stored credential" };
		if (type === "api_key") {
			const subs = await host.session.modelRuntime.subscriptionManager.list(providerId);
			if (subs.length > 1) {
				for (const sub of subs) {
					options.push({
						id: `${providerId}#${sub.id}`,
						name: `${name} — ${sub.name}`,
						authType: type,
						status,
					});
				}
				options.push({ id: `${providerId}#all`, name: `${name} — all subscriptions`, authType: type, status });
				continue;
			}
		}
		options.push({ id: providerId, name, authType: type, status });
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

// lunr: remove every pool key for a provider; removing the last key also deletes
// the auth.json credential, so the modelRuntime.logout afterwards is a no-op delete.
async function removeAllSubscriptions(host: LoginFlowHost, providerId: string): Promise<void> {
	const manager = host.session.modelRuntime.subscriptionManager;
	const subs = await manager.list(providerId);
	for (const sub of subs) {
		await manager.removeKey(providerId, sub.id);
	}
}

/**
 * Removes scoped models whose provider has no credential left after a logout, from settings and from
 * this session's ctrl+p cycle. A provider still reachable through an environment key keeps its models.
 */
async function forgetSignedOutScopedModels(host: LoginFlowHost): Promise<void> {
	const { modelRuntime: runtime, settingsManager } = host.session;
	const signedOut = await findSignedOutScopePatterns(settingsManager.getEnabledModels() ?? [], runtime);
	if (signedOut.length > 0) settingsManager.removeEnabledModels(signedOut);
	const scoped = host.session.scopedModels;
	const auth = await Promise.all(scoped.map((entry) => runtime.checkAuth(entry.model.provider)));
	const kept = scoped.filter((_, index) => auth[index]);
	if (kept.length !== scoped.length) host.session.setScopedModels(kept);
}

export async function showOAuthSelector(host: LoginFlowHost, mode: "login" | "logout"): Promise<void> {
	if (mode === "login") {
		showLoginAuthTypeSelector(host);
		return;
	}

	const providerOptions = await getLogoutProviderOptions(host);
	if (providerOptions.length === 0) {
		host.showStatus(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		);
		return;
	}

	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			mode,
			providerOptions,
			async (providerId: string) => {
				done();

				const providerOption = providerOptions.find((provider) => provider.id === providerId);
				if (!providerOption) {
					return;
				}

				try {
					// lunr: pool-aware logout — "provider#subId" removes one key,
					// "provider#all" and plain entries remove everything.
					const hashIndex = providerOption.id.indexOf("#");
					if (hashIndex > 0) {
						const poolProviderId = providerOption.id.slice(0, hashIndex);
						const subRef = providerOption.id.slice(hashIndex + 1);
						if (subRef !== "all") {
							await host.session.modelRuntime.subscriptionManager.removeKey(poolProviderId, subRef);
							await host.updateAvailableProviderCount();
							host.showStatus(`Removed subscription ${providerOption.name}.`);
							return;
						}
						await removeAllSubscriptions(host, poolProviderId);
						await host.session.modelRuntime.logout(poolProviderId);
						await forgetSignedOutScopedModels(host);
						await host.updateAvailableProviderCount();
						const poolProviderName =
							host.session.modelRuntime.getProvider(poolProviderId)?.name ?? poolProviderId;
						host.showStatus(`Removed all subscriptions for ${poolProviderName}`);
						return;
					}

					// lunr: a plain entry can still have a lazy-imported pool — clear it so
					// rotation cannot resurrect the removed credential.
					await removeAllSubscriptions(host, providerOption.id);
					const removed = await host.session.modelRuntime.readCredential(providerOption.id);
					await host.session.modelRuntime.logout(providerOption.id);
					await forgetSignedOutScopedModels(host);
					await host.updateAvailableProviderCount();
					const message =
						removed?.type === "external_claude_code"
							? `Logged out of ${providerOption.name}. ${formatClaudeSubscriptionLogoutNote(removed)}`
							: providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
					host.showStatus(message);
				} catch (error: unknown) {
					host.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

export async function completeProviderAuthentication(
	host: LoginFlowHost,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
	previousModel: Model<Api> | undefined,
	// lunr: lets the subscription add-flow adjust the status wording.
	overrides?: { actionLabel?: string; savedNote?: string },
): Promise<void> {
	await host.session.modelRuntime.getAvailable();

	const actionLabel =
		overrides?.actionLabel ??
		(authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`);
	const savedNote = overrides?.savedNote ?? `Credentials saved to ${getAuthPath()}`;

	let selectedModel: Model<Api> | undefined;
	let selectionError: string | undefined;
	if (isUnknownModel(previousModel)) {
		const availableModels = await host.session.modelRuntime.getAvailable();
		const providerModels = availableModels.filter((model) => model.provider === providerId);
		if (!hasDefaultModelProvider(providerId)) {
			selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
		} else if (providerModels.length === 0) {
			selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
		} else {
			const defaultModelId = defaultModelPerProvider[providerId];
			// Plans offer different models. Without the default, take the provider's first model, as startup
			// does; for a Claude subscription that is Claude Code's own default.
			selectedModel = providerModels.find((model) => model.id === defaultModelId) ?? providerModels[0];
			try {
				await host.session.setModel(selectedModel);
			} catch (error: unknown) {
				selectedModel = undefined;
				const errorMessage = error instanceof Error ? error.message : String(error);
				selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
			}
		}
	}

	await host.updateAvailableProviderCount();
	host.invalidateFooter();
	host.updateEditorBorderColor();
	if (selectedModel) {
		host.showStatus(`${actionLabel}. Selected ${selectedModel.id}. ${savedNote}`);
		void host.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
	} else {
		host.showStatus(`${actionLabel}. ${savedNote}`);
		if (selectionError) {
			host.showError(selectionError);
		} else {
			void host.maybeWarnAboutAnthropicSubscriptionAuth();
		}
	}
	await host.openModelSelectorIfUnset();
}

export function showAmbientAuthDialog(host: LoginFlowHost, providerOption: AuthSelectorProvider): void {
	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	const dialog = new LoginDialogComponent(
		host.ui,
		providerOption.id,
		() => restoreEditor(),
		providerOption.name,
		`${providerOption.name} setup`,
	);
	dialog.showInfo(`${providerOption.method?.name ?? "Authentication"} is configured outside lunR.`, [], true);

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();
}

export async function showApiKeyLoginDialog(
	host: LoginFlowHost,
	providerId: string,
	providerName: string,
): Promise<void> {
	const previousModel = host.session.model;

	// lunr: multi-subscription pools — when the provider already has stored keys,
	// ask whether the new key joins the pool or replaces it.
	const subscriptionManager = host.session.modelRuntime.subscriptionManager;
	const existingSubs = await subscriptionManager.list(providerId);
	let poolMode: "add" | "replace" | undefined;
	if (existingSubs.length > 0) {
		poolMode = await chooseSubscriptionLoginMode(host, providerName, existingSubs.length);
		if (poolMode === undefined) {
			host.showStatus("Login cancelled.");
			return;
		}
	}

	const dialog = new LoginDialogComponent(
		host.ui,
		providerId,
		(_success, _message) => {
			// Completion handled below
		},
		providerName,
	);

	if (providerId === "amazon-bedrock") {
		dialog.showDetails([
			theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);
	}

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		const credential = await loginProvider(host, dialog, providerId, "api_key");
		restoreEditor();
		if (poolMode === "add" && credential.type === "api_key" && credential.key !== undefined) {
			const entry = await subscriptionManager.addKey(providerId, credential.key);
			await completeProviderAuthentication(host, providerId, providerName, "api_key", previousModel, {
				actionLabel: `Added subscription "${entry.name}" for ${providerName}`,
				savedNote: "Key stored in the subscription pool. Rename it in /settings → API keys.",
			});
			return;
		}
		if (poolMode === "replace") {
			await replaceSubscriptionPool(host, providerId, credential);
		}
		await completeProviderAuthentication(host, providerId, providerName, "api_key", previousModel);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg !== "Login cancelled") {
			host.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
		}
	}
}

// lunr: add-vs-replace picker shown when an API-key provider already has stored keys.
function chooseSubscriptionLoginMode(
	host: LoginFlowHost,
	providerName: string,
	keyCount: number,
): Promise<"add" | "replace" | undefined> {
	return new Promise((resolve) => {
		host.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				`${providerName} already has ${keyCount} stored key${keyCount === 1 ? "" : "s"}.`,
				["Add as new subscription", "Replace existing"],
				(option) => {
					done();
					resolve(option === "Add as new subscription" ? "add" : "replace");
				},
				() => {
					done();
					resolve(undefined);
				},
				{
					message:
						"Add keeps the existing keys in a pool you can switch between; Replace overwrites them with the new key.",
				},
			);
			return { component: selector, focus: selector };
		});
	});
}

// lunr: "Replace existing" collapses the pool to the single key login just stored,
// so rotation cannot resurrect replaced keys. Removing the last pool key deletes the
// auth.json credential, and addKey re-mirrors the same key the login already stored.
async function replaceSubscriptionPool(host: LoginFlowHost, providerId: string, credential: Credential): Promise<void> {
	const subscriptionManager = host.session.modelRuntime.subscriptionManager;
	const subs = await subscriptionManager.list(providerId);
	for (const sub of subs) {
		await subscriptionManager.removeKey(providerId, sub.id);
	}
	if (credential.type === "api_key" && credential.key !== undefined) {
		await subscriptionManager.addKey(providerId, credential.key);
	}
}

function showAuthSelect(
	host: LoginFlowHost,
	dialog: LoginDialogComponent,
	prompt: Extract<AuthPrompt, { type: "select" }>,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const restoreDialog = () => {
			host.editorContainer.clear();
			host.editorContainer.addChild(dialog);
			host.ui.setFocus(dialog);
			host.ui.requestRender();
		};
		const labels = prompt.options.map((option) => option.label);
		const selector = new ExtensionSelectorComponent(
			prompt.message,
			labels,
			(optionLabel) => {
				restoreDialog();
				const id = prompt.options.find((option) => option.label === optionLabel)?.id;
				if (id) resolve(id);
				else reject(new Error("Login cancelled"));
			},
			() => {
				restoreDialog();
				reject(new Error("Login cancelled"));
			},
		);
		host.editorContainer.clear();
		host.editorContainer.addChild(selector);
		host.ui.setFocus(selector);
		host.ui.requestRender();
	});
}

async function showAuthPrompt(host: LoginFlowHost, dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
	let response: Promise<string>;
	if (prompt.type === "select") {
		response = showAuthSelect(host, dialog, prompt);
	} else if (prompt.type === "manual_code") {
		response = dialog.showManualInput(prompt.message);
	} else {
		response = dialog.showPrompt(prompt.message, prompt.placeholder);
	}
	if (!prompt.signal) return response;
	if (prompt.signal.aborted) throw new Error("Login cancelled");
	const signal = prompt.signal;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<string>((_resolve, reject) => {
		onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([response, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") {
		dialog.showAuth(event.url, event.instructions);
	} else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("Waiting for authentication...");
	} else if (event.type === "info") {
		dialog.showInfo(event.message, event.links);
	} else {
		dialog.showProgress(event.message);
	}
}

async function loginProvider(
	host: LoginFlowHost,
	dialog: LoginDialogComponent,
	providerId: string,
	method: "api_key" | "oauth",
): Promise<Credential> {
	return host.session.modelRuntime.login(providerId, method, {
		signal: dialog.signal,
		prompt: (prompt) => showAuthPrompt(host, dialog, prompt),
		notify: (event) => notifyAuthDialog(dialog, event),
		handoff: async (command, args, env) => {
			host.ui.stop();
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawn(command, [...args], { stdio: "inherit", env, windowsHide: false });
					const abort = () => child.kill();
					dialog.signal.addEventListener("abort", abort, { once: true });
					if (dialog.signal.aborted) abort();
					child.once("error", (error) => {
						dialog.signal.removeEventListener("abort", abort);
						reject(error);
					});
					child.once("close", (code) => {
						dialog.signal.removeEventListener("abort", abort);
						if (code === 0) resolve();
						else reject(new Error("Claude Code login did not complete"));
					});
				});
			} finally {
				host.ui.start();
			}
		},
	});
}

export async function showLoginDialog(host: LoginFlowHost, providerId: string, providerName: string): Promise<void> {
	const previousModel = host.session.model;
	const dialog = new LoginDialogComponent(host.ui, providerId, (_success, _message) => {}, providerName);
	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		await loginProvider(host, dialog, providerId, "oauth");
		restoreEditor();
		await completeProviderAuthentication(host, providerId, providerName, "oauth", previousModel);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg !== "Login cancelled") {
			host.showError(`Failed to login to ${providerName}: ${errorMsg}`);
		}
	}
}
