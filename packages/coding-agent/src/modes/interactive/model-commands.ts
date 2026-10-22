/**
 * Model and subscription commands for interactive mode: /model and its picker, /scoped-models,
 * /refresh, the subscription picker after a model pick, and the API key pool counts and rows the
 * /settings menu shows. InteractiveMode supplies the session and UI through ModelCommandHost.
 */

import type { Api } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { formatCatalogRefreshSummary } from "../../core/catalog-merge.ts";
import { globalBridge } from "../../core/global-bridge.ts";
import { findExactModelReferenceMatch, resolveModelScopeWithDiagnostics } from "../../core/model-resolver.ts";
import { refreshModelCandidatesForInit } from "../../core/model-runtime.ts";
import type { SubEntry } from "../../core/subscriptions.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { formatSubscriptionExhaustedUntil, type SubscriptionRowInfo } from "./components/settings-selector.ts";

/** What the model commands need from InteractiveMode. InteractiveMode builds one in `createModelCommandHost`. */
export interface ModelCommandHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	/** True while the session is detached or being transferred. */
	isSessionDetached(): boolean;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	invalidateFooter(): void;
	updateEditorBorderColor(): void;
	updateAvailableProviderCount(): Promise<void>;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api>): Promise<void>;
}

// lunr: pi-ollama-cloud registers its catalog refresh here for /refresh.
const ollamaCloudRefreshBridge = globalBridge<
	(ctx: { ui: unknown; auth?: { apiKey?: string; headers?: Record<string, string> } }) => Promise<unknown>
>(Symbol.for("@lunr/ollama-cloud-refresh"));

export async function handleModelCommand(host: ModelCommandHost, searchTerm?: string): Promise<void> {
	if (!searchTerm) {
		await showModelSelector(host);
		return;
	}

	const model = await findExactModelMatch(host.session, searchTerm);
	if (model) {
		try {
			await host.session.setModel(model);
			host.invalidateFooter();
			host.updateEditorBorderColor();
			host.showStatus(`Model: ${model.id}`);
			void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
		} catch (error) {
			host.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	await showModelSelector(host, searchTerm);
}

// lunr: /refresh — local provider /models + official GitHub overlay. Never pi.dev.
// Ollama Cloud still re-registers via its bridge after the core refresh.
export async function handleRefreshCommand(host: ModelCommandHost): Promise<void> {
	const runtime = host.session.modelRuntime;
	const allowNetwork = runtime.isNetworkAllowed();
	if (!allowNetwork) {
		host.showStatus("Model network refresh is disabled (offline mode). Reloaded from cache only.");
	}
	let result: Awaited<ReturnType<typeof runtime.refresh>>;
	try {
		result = await runtime.refresh({ allowNetwork, force: true });
	} catch (error) {
		host.showStatus(`Model refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		host.invalidateFooter();
		return;
	}

	// Discovered metadata stays in its cache, not in user overrides. Enrichment is automatic.
	const extraDefaults = result.incomplete.length;
	const asked: string[] = [];

	let ollama: string | undefined;
	const runner = host.session.extensionRunner;
	const cloudRefresh = ollamaCloudRefreshBridge.get();
	if (cloudRefresh && allowNetwork) {
		try {
			const resolution = await runtime.getAuth("ollama-cloud");
			await cloudRefresh({
				ui: runner.createCommandContext().ui,
				auth: resolution
					? {
							apiKey: resolution.auth.apiKey,
							headers: Object.fromEntries(
								Object.entries(resolution.auth.headers ?? {}).filter(
									(entry): entry is [string, string] => entry[1] !== null,
								),
							),
						}
					: undefined,
			});
		} catch (error) {
			ollama = `ollama-cloud refresh failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	host.session.refreshModelFromRegistry();
	host.showStatus(
		formatCatalogRefreshSummary({
			official: result.official
				? {
						source: result.official.source,
						modelCount: result.official.catalog.models.length,
						evictedUserRows: result.official.evictedUserRows,
					}
				: undefined,
			providers: [
				...result.live.map((entry) => ({
					id: entry.providerId,
					status: entry.status,
					added: entry.added,
					total: entry.total,
					error: entry.error,
				})),
				...Object.entries(result.official?.errors ?? {}).map(([id, error]) => ({
					id,
					status: "error" as const,
					error,
				})),
			],
			asked,
			extraDefaults,
			ollama,
		}),
	);
	host.invalidateFooter();
}

async function findExactModelMatch(session: AgentSession, searchTerm: string): Promise<Model<Api> | undefined> {
	const models = await getModelCandidates(session);
	return findExactModelReferenceMatch(searchTerm, models);
}

export async function getModelCandidates(session: AgentSession): Promise<Model<Api>[]> {
	if (session.scopedModels.length > 0) {
		return session.scopedModels.map((scoped) => scoped.model);
	}

	try {
		return [...(await refreshModelCandidatesForInit(session.modelRuntime))];
	} catch {
		return [];
	}
}

// `selectedStatus` replaces the "Model: <id>" status after a pick (the post-login picker prints a ready line).
export async function showModelSelector(
	host: ModelCommandHost,
	initialSearchInput?: string,
	selectedStatus?: string,
): Promise<void> {
	if (host.isSessionDetached()) return;
	// lunr: prefetch active subscription names so row rendering stays synchronous.
	const subscriptionNames = await getActiveSubscriptionNames(host.session);
	host.showSelector((done) => {
		const selector = new ModelSelectorComponent(
			host.ui,
			host.session.model,
			host.session.settingsManager,
			host.session.modelRuntime,
			host.session.scopedModels,
			async (model) => {
				try {
					await host.session.setModel(model);
					host.invalidateFooter();
					host.updateEditorBorderColor();
					done();
					host.showStatus(selectedStatus ?? `Model: ${model.id}`);
					void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
					// lunr: offer manual subscription switching for pooled providers.
					await maybeShowSubscriptionPicker(host, model.provider);
				} catch (error) {
					done();
					host.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			initialSearchInput,
			{ subscriptionNames },
		);
		return { component: selector, focus: selector };
	});
}

// lunr: providerId → active subscription name for providers with a multi-key pool.
// Empty when auto-manage subscriptions is on (no manual switching UI then).
async function getActiveSubscriptionNames(session: AgentSession): Promise<ReadonlyMap<string, string>> {
	const names = new Map<string, string>();
	if (session.settingsManager.getAutoManageSubscriptions()) return names;
	try {
		const manager = session.modelRuntime.subscriptionManager;
		for (const { providerId, type } of await session.modelRuntime.listCredentials()) {
			if (type !== "api_key") continue;
			const subs = await manager.list(providerId);
			if (subs.length < 2) continue;
			const active = await manager.getActive(providerId);
			if (active) names.set(providerId, active.name);
		}
	} catch {
		// Pool read failures must not break the model selector.
	}
	return names;
}

// lunr: after a model pick, offer manual subscription switching for pooled providers.
// Skipped when auto-manage is on; the model selection stands either way.
async function maybeShowSubscriptionPicker(host: ModelCommandHost, providerId: string): Promise<void> {
	if (host.session.settingsManager.getAutoManageSubscriptions()) return;
	const manager = host.session.modelRuntime.subscriptionManager;
	const subs = await manager.list(providerId);
	if (subs.length < 2) return;
	const activeId = (await manager.getActive(providerId))?.id;
	const labels = subs.map((sub) => formatSubscriptionPickerLabel(sub, sub.id === activeId));
	host.showSelector((done) => {
		const selector = new ExtensionSelectorComponent(
			`Select active subscription for ${providerId}:`,
			labels,
			(option) => {
				done();
				const sub = subs[labels.indexOf(option)];
				if (!sub || sub.id === activeId) {
					host.ui.requestRender();
					return;
				}
				manager.setActive(providerId, sub.id).then(
					() => host.showStatus(`Subscription: ${sub.name} (${providerId})`),
					(error: unknown) =>
						host.showError(
							`Failed to switch subscription: ${error instanceof Error ? error.message : String(error)}`,
						),
				);
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

// lunr: picker row label — "work (active)", "Sub 3 · exhausted until 14:30".
function formatSubscriptionPickerLabel(sub: SubEntry, isActive: boolean): string {
	let label = sub.name;
	if (isActive) label += " (active)";
	if (sub.exhaustedUntil !== undefined) {
		label += ` · exhausted until ${formatSubscriptionExhaustedUntil(sub.exhaustedUntil)}`;
	}
	return label;
}

// lunr: total pool size across providers, for the /settings Subscriptions row label.
export async function countSubscriptions(session: AgentSession): Promise<number> {
	try {
		let count = 0;
		for (const { providerId, type } of await session.modelRuntime.listCredentials()) {
			if (type !== "api_key") continue;
			count += (await session.modelRuntime.subscriptionManager.list(providerId)).length;
		}
		return count;
	} catch {
		return 0;
	}
}

// lunr: plain-data rows for the /settings Subscriptions submenu (manager stays in core).
export async function listSubscriptionRows(session: AgentSession): Promise<SubscriptionRowInfo[]> {
	const rows: SubscriptionRowInfo[] = [];
	const manager = session.modelRuntime.subscriptionManager;
	for (const { providerId, type } of await session.modelRuntime.listCredentials()) {
		if (type !== "api_key") continue;
		const providerName = session.modelRuntime.getProvider(providerId)?.name ?? providerId;
		const subs = await manager.list(providerId);
		const activeId = (await manager.getActive(providerId))?.id;
		for (const sub of subs) {
			rows.push({
				providerId,
				providerName,
				id: sub.id,
				name: sub.name,
				active: sub.id === activeId,
				...(sub.exhaustedUntil !== undefined ? { exhaustedUntil: sub.exhaustedUntil } : {}),
			});
		}
	}
	return rows;
}

export async function showModelsSelector(host: ModelCommandHost): Promise<void> {
	// Get all available models
	await host.session.modelRuntime.refresh();
	const allModels = [...(await host.session.modelRuntime.getAvailable())];

	if (allModels.length === 0) {
		host.showStatus("No models available");
		return;
	}

	// Check if session has scoped models (from previous session-only changes or CLI --models)
	const sessionScopedModels = host.session.scopedModels;
	const hasSessionScope = sessionScopedModels.length > 0;

	// Build enabled model IDs from session state or settings
	let currentEnabledIds: string[] | null = null;

	if (hasSessionScope) {
		// Use current session's scoped models
		currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	} else {
		// Fall back to settings
		const patterns = host.session.settingsManager.getEnabledModels();
		if (patterns !== undefined && patterns.length > 0) {
			// Unmatched patterns stay unchecked here; a console warning would draw over the TUI.
			const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, host.session.modelRuntime);
			currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		}
	}

	// Helper to update session's scoped models (session-only, no persist)
	const updateSessionModels = async (enabledIds: string[] | null) => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
			const { scopedModels: newScopedModels } = await resolveModelScopeWithDiagnostics(
				enabledIds,
				host.session.modelRuntime,
			);
			host.session.setScopedModels(
				newScopedModels.map((sm) => ({
					model: sm.model,
					thinkingLevel: sm.thinkingLevel,
				})),
			);
		} else {
			// All enabled or none enabled = no filter
			host.session.setScopedModels([]);
		}
		await host.updateAvailableProviderCount();
		host.ui.requestRender();
	};

	host.showSelector((done) => {
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels,
				enabledModelIds: currentEnabledIds,
			},
			{
				onChange: async (enabledIds) => {
					await updateSessionModels(enabledIds);
				},
				onPersist: (enabledIds) => {
					// Persist to settings
					const newPatterns =
						enabledIds === null || enabledIds.length === allModels.length
							? undefined // All enabled = clear filter
							: enabledIds;
					host.session.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
					host.showStatus("Model selection saved to settings");
				},
				onCancel: () => {
					done();
					host.ui.requestRender();
				},
			},
		);
		return { component: selector, focus: selector };
	});
}
