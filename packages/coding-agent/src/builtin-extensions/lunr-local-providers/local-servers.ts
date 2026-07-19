/**
 * Local model server discovery for lunR (Ollama, LM Studio).
 *
 * Pure functions with no runtime imports so the probing and response
 * normalization can be harness-tested directly against a mock HTTP server.
 * The extension factory lives in index.ts.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

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
