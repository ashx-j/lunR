import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getAgentDir, getPackageDir, VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

/** Directory on GitHub raw (`providers.json` + `providers/{id}.json`). Override with `LUNR_OFFICIAL_CATALOG_URL`. */
export const OFFICIAL_CATALOG_DEFAULT_URL = "https://raw.githubusercontent.com/ashx-j/lunR/master/catalog";
export const OFFICIAL_CATALOG_TIMEOUT_MS = 4000;
export const OFFICIAL_CATALOG_CACHE_FILENAME = "official-catalog-cache.json";

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const META_KEYS = new Set(["version", "updatedAt", "generatedAt", "sourceCommit", "providerCount", "modelCount"]);

export interface OfficialModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface OfficialModelEntry {
	id: string;
	name: string;
	api: Api;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: OfficialModelCost;
	contextWindow: number;
	maxTokens: number;
	compat?: Model<Api>["compat"];
	thinkingLevelMap?: ThinkingLevelMap;
	headers?: Record<string, string>;
}

export interface OfficialCatalogFile {
	version: number;
	updatedAt: string;
	models: OfficialModelEntry[];
}

export type OfficialCatalogSource = "github" | "cache" | "bundled";

export interface OfficialCatalogLoadResult {
	catalog: OfficialCatalogFile;
	source: OfficialCatalogSource;
}

/** Seed shipped in-repo; used when the JSON file cannot be read. */
export const BUNDLED_OFFICIAL_CATALOG: OfficialCatalogFile = {
	version: 1,
	updatedAt: "2026-08-15T00:00:00Z",
	models: [
		{
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 500000,
		},
	],
};

export function officialCatalogCachePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, OFFICIAL_CATALOG_CACHE_FILENAME);
}

/** Base URL (no trailing slash). `LUNR_OFFICIAL_CATALOG_URL` overrides the directory, not a single file. */
export function officialCatalogBaseUrl(override?: string): string {
	const raw = (override ?? process.env.LUNR_OFFICIAL_CATALOG_URL)?.trim() || OFFICIAL_CATALOG_DEFAULT_URL;
	return raw.replace(/\/+$/, "");
}

/** @deprecated Use officialCatalogBaseUrl. Kept as an alias for the directory base. */
export function officialCatalogUrl(): string {
	return officialCatalogBaseUrl();
}

export function officialCatalogUrlFor(path: string, base?: string): string {
	const normalized = path.replace(/^\/+/, "");
	return `${officialCatalogBaseUrl(base)}/${normalized}`;
}

export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseCost(value: unknown): OfficialModelCost | undefined {
	if (!isRecord(value)) return undefined;
	const input = asFiniteNumber(value.input);
	const output = asFiniteNumber(value.output);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: asFiniteNumber(value.cacheRead) ?? 0,
		cacheWrite: asFiniteNumber(value.cacheWrite) ?? 0,
	};
}

function parseInput(value: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const input: ("text" | "image")[] = [];
	for (const entry of value) {
		if (entry === "text" || entry === "image") input.push(entry);
	}
	return input.length > 0 ? input : undefined;
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (!isRecord(value)) return undefined;
	const map: ThinkingLevelMap = {};
	let any = false;
	for (const level of THINKING_LEVEL_KEYS) {
		const mapped = value[level];
		if (mapped === null || typeof mapped === "string") {
			map[level] = mapped;
			any = true;
		}
	}
	return any ? map : undefined;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (typeof headerValue === "string") headers[name] = headerValue;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseOfficialEntry(value: unknown): OfficialModelEntry | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id.trim() : "";
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	if (!id || !provider) return undefined;
	const api = typeof value.api === "string" && value.api.trim() ? value.api.trim() : "openai-completions";
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
	const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
	const cost = parseCost(value.cost) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const input = parseInput(value.input) ?? ["text"];
	const compat = isRecord(value.compat) ? (value.compat as Model<Api>["compat"]) : undefined;
	const thinkingLevelMap = parseThinkingLevelMap(value.thinkingLevelMap);
	const headers = parseHeaders(value.headers);
	return {
		id,
		name,
		api: api as Api,
		provider,
		baseUrl,
		reasoning: value.reasoning === true,
		input,
		cost,
		contextWindow: asFiniteNumber(value.contextWindow) ?? 128000,
		maxTokens: asFiniteNumber(value.maxTokens) ?? 8192,
		...(compat ? { compat } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(headers ? { headers } : {}),
	};
}

function catalogFile(models: OfficialModelEntry[], value?: Record<string, unknown>): OfficialCatalogFile {
	const version = value ? (asFiniteNumber(value.version) ?? 1) : 1;
	const updatedAt = value && typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : "";
	return { version, updatedAt, models };
}

function parseKeyedCatalog(value: Record<string, unknown>): OfficialCatalogFile | undefined {
	const models: OfficialModelEntry[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (META_KEYS.has(key) || !isRecord(entry)) continue;
		if (typeof entry.id === "string") {
			const parsed = parseOfficialEntry(entry);
			if (parsed) models.push(parsed);
			continue;
		}
		for (const [modelId, model] of Object.entries(entry)) {
			if (!isRecord(model)) continue;
			const parsed = parseOfficialEntry({
				...model,
				id: typeof model.id === "string" && model.id.trim() ? model.id : modelId,
				provider: typeof model.provider === "string" && model.provider.trim() ? model.provider : key,
			});
			if (parsed) models.push(parsed);
		}
	}
	return models.length > 0 ? catalogFile(models, value) : undefined;
}

/** Parse an official catalog document. Returns undefined on a bad shape (never throws). */
export function parseOfficialCatalog(value: unknown): OfficialCatalogFile | undefined {
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.models)) {
		const models: OfficialModelEntry[] = [];
		for (const entry of value.models) {
			const parsed = parseOfficialEntry(entry);
			if (parsed) models.push(parsed);
		}
		return catalogFile(models, value);
	}
	if ("models" in value) return undefined;
	return parseKeyedCatalog(value);
}

function parseProviderIndex(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return value;
}

function readCatalogFile(path: string): OfficialCatalogFile | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return parseOfficialCatalog(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function bundledCatalogCandidates(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const packageDir = getPackageDir();
	return [
		join(packageDir, "dist", "catalog", "models.json"),
		join(packageDir, "..", "..", "catalog", "models.json"),
		join(here, "../../../../catalog/models.json"),
		join(packageDir, "catalog", "models.json"),
		join(here, "../catalog/models.json"),
		join(here, "models.json"),
		join(packageDir, "dist", "catalog", "official-models.json"),
		join(packageDir, "..", "..", "catalog", "official-models.json"),
		join(here, "../../../../catalog/official-models.json"),
		join(here, "official-models.json"),
		join(here, "../catalog/official-models.json"),
	];
}

export function loadBundledOfficialCatalog(): OfficialCatalogFile {
	for (const path of bundledCatalogCandidates()) {
		const parsed = readCatalogFile(path);
		if (parsed) return parsed;
	}
	return BUNDLED_OFFICIAL_CATALOG;
}

export function loadCachedOfficialCatalog(cachePath?: string): OfficialCatalogFile | undefined {
	if (!cachePath) return undefined;
	return readCatalogFile(cachePath);
}

export function writeOfficialCatalogCache(catalog: OfficialCatalogFile, cachePath: string): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
		writeFileSync(cachePath, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");
	} catch {
		// Cache is best-effort.
	}
}

export function officialModelsByProvider(catalog: OfficialCatalogFile): Map<string, OfficialModelEntry[]> {
	const byProvider = new Map<string, OfficialModelEntry[]>();
	for (const model of catalog.models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	return byProvider;
}

/** Replace or add per-provider rows. Existing providers not in `replacements` are kept. */
export function mergeOfficialCatalogByProvider(
	base: OfficialCatalogFile,
	replacements: ReadonlyMap<string, OfficialModelEntry[]>,
	updatedAt?: string,
): OfficialCatalogFile {
	const byProvider = officialModelsByProvider(base);
	for (const [providerId, models] of replacements) {
		byProvider.set(providerId, models);
	}
	return {
		version: base.version || 1,
		updatedAt: updatedAt ?? new Date().toISOString(),
		models: [...byProvider.values()].flat(),
	};
}

/** Bundled as the floor; cache rows win per provider. */
export function officialCatalogBase(bundled: OfficialCatalogFile, cachePath?: string): OfficialCatalogFile {
	const cached = loadCachedOfficialCatalog(cachePath);
	if (!cached) return bundled;
	return mergeOfficialCatalogByProvider(bundled, officialModelsByProvider(cached), cached.updatedAt);
}

/** A completed GitHub overlay must not be replaced by cache/bundled. */
export function preferOfficialCatalog(
	previous: OfficialCatalogLoadResult | undefined,
	next: OfficialCatalogLoadResult,
): OfficialCatalogLoadResult {
	if (next.source === "github") return next;
	if (previous?.source === "github") return previous;
	return next;
}

export function officialModelKeys(catalog: OfficialCatalogFile): Set<string> {
	return new Set(catalog.models.map((model) => modelKey(model.provider, model.id)));
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function officialEntryToModel(entry: OfficialModelEntry, template?: Model<Api>): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: entry.api || template?.api || "openai-completions",
		provider: entry.provider,
		baseUrl: entry.baseUrl || template?.baseUrl || "",
		reasoning: entry.reasoning,
		input: entry.input.length > 0 ? entry.input : (template?.input ?? ["text"]),
		cost: entry.cost ?? template?.cost ?? ZERO_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat ?? template?.compat,
		thinkingLevelMap: entry.thinkingLevelMap ?? template?.thinkingLevelMap,
		headers: entry.headers ?? template?.headers,
	};
}

export interface LoadOfficialCatalogOptions {
	allowNetwork?: boolean;
	cachePath?: string;
	bundled?: OfficialCatalogFile;
	/** Catalog directory base (not a single-file URL). */
	url?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** Stored-credential provider ids. Only these shards are fetched. */
	providerIds?: readonly string[];
}

function resolveBundledCatalog(bundled?: OfficialCatalogFile): OfficialCatalogFile {
	if (bundled) return bundled;
	return loadBundledOfficialCatalog();
}

function fallbackCatalog(bundled: OfficialCatalogFile | undefined, cachePath?: string): OfficialCatalogLoadResult {
	const cached = loadCachedOfficialCatalog(cachePath);
	if (cached) return { catalog: cached, source: "cache" };
	const resolved = resolveBundledCatalog(bundled);
	if (resolved.models.length > 0) return { catalog: resolved, source: "bundled" };
	return { catalog: BUNDLED_OFFICIAL_CATALOG, source: "bundled" };
}

async function fetchJson(
	url: string,
	options: {
		timeoutMs: number;
		signal?: AbortSignal;
		fetchImpl: typeof fetch;
		headers: Record<string, string>;
	},
): Promise<{ ok: true; value: unknown } | { ok: false; status?: number }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const onParentAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onParentAbort, { once: true });
	if (options.signal?.aborted) controller.abort();
	try {
		const abortError = () => {
			const error = new Error("The operation was aborted");
			error.name = "AbortError";
			return error;
		};
		const response = await Promise.race([
			options.fetchImpl(url, {
				headers: options.headers,
				signal: controller.signal,
			}),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
				if (controller.signal.aborted) reject(abortError());
			}),
		]);
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, value: await response.json() };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Load the official overlay. Network only when allowNetwork is true.
 * Fetches providers.json, then providers/{id}.json for stored-credential providers.
 * Successful shards replace that provider only; failed shards keep cache/bundled rows.
 * All requested shards failed → cache, then bundled. Never writes a worse cache. Never throws.
 */
export async function loadOfficialCatalog(
	options: LoadOfficialCatalogOptions = {},
): Promise<OfficialCatalogLoadResult> {
	const cachePath = options.cachePath;
	// Cache-only: prefer the on-disk cache and skip parsing bundled models.json.
	if (!options.allowNetwork) {
		return fallbackCatalog(options.bundled, cachePath);
	}

	const bundled = resolveBundledCatalog(options.bundled);
	const timeoutMs = options.timeoutMs ?? OFFICIAL_CATALOG_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = {
		accept: "application/json",
		"User-Agent": getPiUserAgent(VERSION),
	};
	const fetchOptions = { timeoutMs, signal: options.signal, fetchImpl, headers };
	const base = options.url ?? officialCatalogBaseUrl();

	try {
		const indexResult = await fetchJson(officialCatalogUrlFor("providers.json", base), fetchOptions);
		if (!indexResult.ok) return fallbackCatalog(bundled, cachePath);
		const index = parseProviderIndex(indexResult.value);
		if (!index) return fallbackCatalog(bundled, cachePath);

		const wanted = new Set(index);
		const requested = options.providerIds ?? [];
		const shardIds = requested.filter((providerId) => wanted.has(providerId));
		if (shardIds.length === 0) return fallbackCatalog(bundled, cachePath);

		const replacements = new Map<string, OfficialModelEntry[]>();
		await Promise.all(
			shardIds.map(async (providerId) => {
				const result = await fetchJson(
					officialCatalogUrlFor(`providers/${encodeURIComponent(providerId)}.json`, base),
					fetchOptions,
				);
				if (!result.ok) return;
				const parsed = parseOfficialCatalog(result.value);
				if (!parsed || parsed.models.length === 0) return;
				replacements.set(providerId, parsed.models);
			}),
		);
		if (replacements.size === 0) return fallbackCatalog(bundled, cachePath);

		const catalog = mergeOfficialCatalogByProvider(officialCatalogBase(bundled, cachePath), replacements);
		if (cachePath) writeOfficialCatalogCache(catalog, cachePath);
		return { catalog, source: "github" };
	} catch {
		return fallbackCatalog(bundled, cachePath);
	}
}
