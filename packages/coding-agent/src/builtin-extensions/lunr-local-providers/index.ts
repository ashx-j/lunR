/**
 * lunR local providers — one-click Ollama and LM Studio.
 *
 * Each local server is registered as an OAuth-style provider where the OAuth
 * credential is a dummy token standing in for the keyless local server. This
 * turns /login into a one-click "detect and connect" flow: selecting the
 * provider probes localhost (3s timeout), stores the dummy credential through
 * the standard login persistence path (Models.login → CredentialStore.modify),
 * refreshes the model list, and auto-selects the first model when no real
 * model is active (mirroring completeProviderAuthentication).
 *
 * Behavior when a server is offline: the model list refreshes to empty and
 * the provider becomes unavailable; nothing throws.
 *
 * Known quirk (documented, not fixed): Ollama tool-calling over the
 * OpenAI-compatible /v1 endpoint can break streaming for some models.
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { fetchLocalModelIds, LOCAL_SERVERS, type LocalServerSpec, toModelConfig } from "./local-servers.ts";

const LOGIN_PROBE_TIMEOUT_MS = 3000;
const REFRESH_TIMEOUT_MS = 3000;
const AUTO_SELECT_POLL_MS = 100;
const AUTO_SELECT_MAX_WAIT_MS = 5000;
/** Dummy local credentials never expire; far-future timestamp (2100-01-01). */
const NEVER_EXPIRES = 4102444800000;

interface ProviderState {
	spec: LocalServerSpec;
	/** Last model list seen from the server; empty when offline. */
	models: ProviderModelConfig[];
	/** Set by the login flow; consumed by the next successful refresh to trigger auto-select. */
	justLoggedIn: boolean;
}

/** Same placeholder check interactive-mode uses before auto-selecting a model after login. */
function isUnknownModel(model: { provider: string; id: string; api: string } | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

export default function lunrLocalProviders(pi: ExtensionAPI): void {
	// Latest event context, kept fresh so the post-login auto-select can see
	// the current model and the availability snapshot.
	let lastCtx: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});
	pi.on("model_select", (_event, ctx) => {
		lastCtx = ctx;
	});

	for (const spec of LOCAL_SERVERS) {
		const state: ProviderState = { spec, models: [], justLoggedIn: false };

		/**
		 * After a successful login the runtime re-refresh may still be in
		 * flight, so poll the availability snapshot briefly, then select the
		 * first local model — but only when the session has no real model,
		 * mirroring completeProviderAuthentication.
		 */
		const scheduleAutoSelect = (): void => {
			const started = Date.now();
			const timer = setInterval(() => {
				const ctx = lastCtx;
				if (!ctx) {
					clearInterval(timer);
					return;
				}
				const first = ctx.modelRegistry.getAvailable().find((model) => model.provider === spec.providerId);
				if (!first) {
					if (Date.now() - started > AUTO_SELECT_MAX_WAIT_MS) clearInterval(timer);
					return;
				}
				clearInterval(timer);
				const current = ctx.model;
				if (current && !isUnknownModel(current)) return;
				void pi.setModel(first);
			}, AUTO_SELECT_POLL_MS);
			timer.unref();
		};

		pi.registerProvider(spec.providerId, {
			name: spec.displayName,
			baseUrl: spec.baseUrl,
			api: "openai-completions",
			models: state.models,
			refreshModels: async (context) => {
				// Cache-only refresh must not probe localhost. A hung IPv6
				// localhost on Windows can sit until REFRESH_TIMEOUT_MS.
				if (!context.allowNetwork) {
					const stored = await context.store.read();
					if (stored?.models?.length) {
						state.models = stored.models.map((model) => toModelConfig(model.id));
					}
					return state.models;
				}
				const ids = await fetchLocalModelIds(spec, REFRESH_TIMEOUT_MS, context.signal);
				state.models = (ids ?? []).map(toModelConfig);
				if (state.models.length > 0) {
					try {
						await context.store.write({
							models: state.models.map((model) => ({
								...model,
								api: "openai-completions" as const,
								provider: spec.providerId,
								baseUrl: spec.baseUrl,
							})),
							checkedAt: Date.now(),
						});
					} catch {
						// Store write is best-effort.
					}
				}
				if (state.justLoggedIn && state.models.length > 0) {
					state.justLoggedIn = false;
					scheduleAutoSelect();
				}
				return state.models;
			},
			oauth: {
				name: spec.displayName,
				login: async (callbacks) => {
					callbacks.onProgress?.(`Looking for ${spec.productName} on localhost:${spec.port}...`);
					const ids = await fetchLocalModelIds(spec, LOGIN_PROBE_TIMEOUT_MS, callbacks.signal);
					if (ids === null) {
						throw new Error(`${spec.productName} not detected on localhost:${spec.port} — start it and retry.`);
					}
					if (ids.length === 0) {
						throw new Error(
							`${spec.productName} is running on localhost:${spec.port} but has no models. Load a model and retry.`,
						);
					}
					state.models = ids.map(toModelConfig);
					state.justLoggedIn = true;
					// Persisted by the standard login flow (Models.login → CredentialStore.modify).
					return { refresh: spec.dummyKey, access: spec.dummyKey, expires: NEVER_EXPIRES };
				},
				refreshToken: async (credentials) => credentials,
				getApiKey: () => spec.dummyKey,
			},
		});
	}
}
