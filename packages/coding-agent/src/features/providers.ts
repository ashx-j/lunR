/**
 * lunR local providers — one-click Ollama and LM Studio (absorbed from the
 * former lunr-local-providers baked-in extension into core).
 *
 * Each local server is registered as an OAuth-style provider where the OAuth
 * credential is a dummy token standing in for the keyless local server. This
 * turns /login into a one-click "detect and connect" flow: selecting the
 * provider probes localhost (3s timeout), stores the dummy credential through
 * the standard login persistence path (Models.login → CredentialStore.modify),
 * refreshes the model list, and auto-selects the first model when no real
 * model is active (mirroring completeProviderAuthentication).
 *
 * The OAuth login flow needs no wiring beyond registerProvider: InteractiveMode's
 * login selectors read `provider.auth.oauth` off the composed providers, which
 * the provider-composer builds from the registered config — the same path the
 * extension API fed.
 *
 * Behavior when a server is offline: the model list refreshes to empty and
 * the provider becomes unavailable; nothing throws.
 *
 * Known quirk (documented, not fixed): Ollama tool-calling over the
 * OpenAI-compatible /v1 endpoint can break streaming for some models.
 */

import type { AgentSession } from "../core/agent-session.ts";
import type { ProviderModelConfig } from "../core/extensions/types.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";

const LOGIN_PROBE_TIMEOUT_MS = 3000;
const REFRESH_TIMEOUT_MS = 3000;
const AUTO_SELECT_POLL_MS = 100;
const AUTO_SELECT_MAX_WAIT_MS = 5000;
/** Dummy local credentials never expire; far-future timestamp (2100-01-01). */
const NEVER_EXPIRES = 4102444800000;

export interface LocalServerSpec {
	/** Provider id used for registration and auth.json keys. */
	providerId: string;
	/** Display name shown in /login and /model. */
	displayName: string;
	/** Bare product name used in probe/login messages. */
	productName: string;
	/** localhost port, for failure messages. */
	port: number;
	/** OpenAI-compatible base URL registered with the provider. */
	baseUrl: string;
	/** OpenAI-style model listing endpoint ({ data: [{ id }] }). */
	modelsUrl: string;
	/** Ollama-only fallback listing endpoint ({ models: [{ name }] }). */
	tagsUrl?: string;
	/** Dummy credential value; local servers need no real key. */
	dummyKey: string;
}

const OLLAMA_ORIGIN = "http://localhost:11434";
const LM_STUDIO_ORIGIN = "http://localhost:1234";

export const OLLAMA_LOCAL: LocalServerSpec = {
	providerId: "ollama-local",
	displayName: "Ollama (local)",
	productName: "Ollama",
	port: 11434,
	baseUrl: `${OLLAMA_ORIGIN}/v1`,
	modelsUrl: `${OLLAMA_ORIGIN}/v1/models`,
	tagsUrl: `${OLLAMA_ORIGIN}/api/tags`,
	dummyKey: "ollama",
};

export const LM_STUDIO: LocalServerSpec = {
	providerId: "lm-studio",
	displayName: "LM Studio (local)",
	productName: "LM Studio",
	port: 1234,
	baseUrl: `${LM_STUDIO_ORIGIN}/v1`,
	modelsUrl: `${LM_STUDIO_ORIGIN}/v1/models`,
	dummyKey: "local",
};

export const LOCAL_SERVERS: readonly LocalServerSpec[] = [OLLAMA_LOCAL, LM_STUDIO];

/**
 * Normalize the two known listing shapes into a deduped id list:
 * - OpenAI style `{ data: [{ id, ... }] }` (Ollama /v1/models, LM Studio)
 * - Ollama /api/tags `{ models: [{ name, ... }] }`
 * Bare string arrays and `id`/`name`/`model` entry fields are tolerated.
 */
export function extractModelIds(payload: unknown): string[] {
	const ids: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0 && !ids.includes(value)) {
			ids.push(value);
		}
	};
	const fromEntry = (entry: unknown): void => {
		if (typeof entry === "string") {
			push(entry);
			return;
		}
		if (entry !== null && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			push(record.id ?? record.name ?? record.model);
		}
	};
	if (Array.isArray(payload)) {
		for (const entry of payload) fromEntry(entry);
		return ids;
	}
	if (payload !== null && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		if (Array.isArray(record.data)) {
			for (const entry of record.data) fromEntry(entry);
		}
		if (Array.isArray(record.models)) {
			for (const entry of record.models) fromEntry(entry);
		}
	}
	return ids;
}

/** Fetch JSON with a hard timeout; null on any network/HTTP/parse failure. Never throws. */
async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = (): void => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return (await response.json()) as unknown;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Probe a local server for its model list.
 * Returns a (possibly empty) id list when the server responded, or null when
 * nothing usable answered — unreachable port, non-JSON, or error status on
 * every known endpoint. Never throws; worst-case delay is ~timeoutMs per
 * endpoint.
 */
export async function fetchLocalModelIds(
	spec: LocalServerSpec,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string[] | null> {
	const payload = await fetchJson(spec.modelsUrl, timeoutMs, signal);
	if (payload !== null) return extractModelIds(payload);
	if (spec.tagsUrl) {
		const fallback = await fetchJson(spec.tagsUrl, timeoutMs, signal);
		if (fallback !== null) return extractModelIds(fallback);
	}
	return null;
}

/**
 * ProviderModelConfig defaults for local models: 32k context, zero cost,
 * text-only. Local servers do not advertise per-model limits, so these are
 * conservative fixed values.
 */
export function toModelConfig(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
	};
}

interface ProviderState {
	spec: LocalServerSpec;
	/** Last model list seen from the server; empty when offline. */
	models: ProviderModelConfig[];
	/** Set by the login flow; consumed by the next successful refresh to trigger auto-select. */
	justLoggedIn: boolean;
}

/**
 * Session access for the post-login auto-select. InteractiveMode configures
 * this with a getter that follows session replacement; before that (and in
 * non-interactive modes, where no login UI exists) auto-select simply no-ops,
 * matching an unloaded extension.
 */
export interface LocalProvidersDeps {
	getSession?: () => AgentSession | undefined;
}

let localProvidersDeps: LocalProvidersDeps = {};

export function configureLocalProvidersDeps(deps: LocalProvidersDeps): void {
	localProvidersDeps = { ...localProvidersDeps, ...deps };
}

/** Same placeholder check interactive-mode uses before auto-selecting a model after login. */
function isUnknownModel(model: { provider: string; id: string; api: string } | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

/**
 * Register the local providers (ollama-local, lm-studio) directly on the model
 * runtime. Called from main.ts on every runtime creation (startup + session
 * replacement), right after services exist and before model resolution — the
 * same lifecycle point extension-registered providers landed at.
 */
export function setupLocalProviders(modelRuntime: ModelRuntime): void {
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
				const session = localProvidersDeps.getSession?.();
				if (!session) {
					clearInterval(timer);
					return;
				}
				const first = session.modelRuntime
					.getAvailableSnapshot()
					.find((model) => model.provider === spec.providerId);
				if (!first) {
					if (Date.now() - started > AUTO_SELECT_MAX_WAIT_MS) clearInterval(timer);
					return;
				}
				clearInterval(timer);
				const current = session.model;
				if (current && !isUnknownModel(current)) return;
				session.setModel(first).catch(() => {});
			}, AUTO_SELECT_POLL_MS);
			timer.unref();
		};

		modelRuntime.registerProvider(spec.providerId, {
			name: spec.displayName,
			baseUrl: spec.baseUrl,
			api: "openai-completions",
			models: state.models,
			refreshModels: async (context) => {
				// Probe even when allowNetwork is false: localhost fails fast
				// (connection refused in ~ms), so the registration-time offline
				// refresh still populates models whenever the server is up.
				const ids = await fetchLocalModelIds(spec, REFRESH_TIMEOUT_MS, context.signal);
				state.models = (ids ?? []).map(toModelConfig);
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
