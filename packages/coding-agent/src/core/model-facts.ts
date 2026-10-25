import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ModelFactsIndex, ModelsDevFacts } from "@earendil-works/pi-ai/catalog/models-dev";
import { getAgentDir, VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { VERSIONED_CATALOG_URL } from "./official-catalog.ts";

/**
 * models.dev facts for models a provider lists before lunR's catalog has them. The hourly
 * publication carries them as `facts.json`; the CLI fetches that file only when live discovery
 * finds an unknown id, and keeps the last good copy on disk.
 */

export const MODEL_FACTS_CACHE_FILENAME = "model-facts-cache.json";
const TIMEOUT_MS = 4000;

interface FactsCache {
	digest: string;
	facts: ModelFactsIndex;
}

export function modelFactsCachePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, MODEL_FACTS_CACHE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCache(path: string): FactsCache | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (isRecord(value) && typeof value.digest === "string" && isRecord(value.facts)) {
			return value as unknown as FactsCache;
		}
	} catch {
		// Missing or unreadable cache.
	}
	return undefined;
}

function writeCache(path: string, cache: FactsCache): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		// The cache is best-effort.
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			/* Renamed or never created. */
		}
	}
}

async function fetchJson(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json", "User-Agent": getPiUserAgent(VERSION) },
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

export interface LoadModelFactsOptions {
	allowNetwork: boolean;
	cachePath?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

/**
 * The published facts, refreshed when the publication's digest changed. Falls back to the cached
 * copy, or undefined when there is none. Never throws.
 */
export async function loadModelFacts(options: LoadModelFactsOptions): Promise<ModelsDevFacts | undefined> {
	const cachePath = options.cachePath ?? modelFactsCachePath();
	const cached = readCache(cachePath);
	// Custom catalog mirrors use the legacy format, which has no facts.
	if (!options.allowNetwork || process.env.LUNR_OFFICIAL_CATALOG_URL) {
		return cached ? ModelsDevFacts.fromIndex(cached.facts) : undefined;
	}
	try {
		const fetchImpl = options.fetchImpl ?? fetch;
		const manifest = await fetchJson(`${VERSIONED_CATALOG_URL}/publication.json`, fetchImpl, options.signal);
		if (!isRecord(manifest) || typeof manifest.facts !== "string" || typeof manifest.revision !== "string") {
			throw new Error("Publication has no facts");
		}
		if (cached?.digest === manifest.facts) return ModelsDevFacts.fromIndex(cached.facts);
		const facts = await fetchJson(
			`${VERSIONED_CATALOG_URL}/snapshots/${manifest.revision}/facts.json`,
			fetchImpl,
			options.signal,
		);
		const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
		if (digest !== manifest.facts || !isRecord(facts)) throw new Error("Facts checksum mismatch");
		writeCache(cachePath, { digest, facts: facts as ModelFactsIndex });
		return ModelsDevFacts.fromIndex(facts as ModelFactsIndex);
	} catch {
		return cached ? ModelsDevFacts.fromIndex(cached.facts) : undefined;
	}
}
