import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUNDLED_OFFICIAL_CATALOG,
	loadOfficialCatalog,
	officialCatalogUrlFor,
	officialEntryToModel,
	parseOfficialCatalog,
	VERSIONED_CATALOG_URL,
} from "../src/core/official-catalog.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = join(tmpdir(), `lunr-official-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const grok46 = {
	id: "grok-4.6",
	name: "Grok 4.6",
	api: "openai-completions" as const,
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 500000,
	maxTokens: 500000,
};

const grok47 = {
	id: "grok-4.7",
	name: "Grok 4.7",
	api: "openai-completions" as const,
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 3, output: 9, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 600000,
	maxTokens: 600000,
	compat: { thinkingFormat: "openrouter" as const, supportsStore: false },
	thinkingLevelMap: { high: "high", low: "low" },
};

const githubCatalog = {
	version: 1,
	updatedAt: "2026-08-16T00:00:00Z",
	models: [grok47],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function shardFetch(handlers: Record<string, unknown | number>): typeof fetch {
	return (async (url: string | URL) => {
		const href = String(url);
		for (const [suffix, payload] of Object.entries(handlers)) {
			if (href.endsWith(suffix)) {
				if (typeof payload === "number") return new Response("error", { status: payload });
				return jsonResponse(payload);
			}
		}
		return new Response("missing", { status: 404 });
	}) as typeof fetch;
}

describe("versioned catalog publication", () => {
	it("reads shards from one immutable revision and checks their digest", async () => {
		const shard = { [grok47.id]: grok47 };
		const hash = createHash("sha256").update(JSON.stringify(shard)).digest("hex");
		const revision = `sha256-${"a".repeat(64)}`;
		const fetchImpl = vi.fn(async (url) =>
			String(url).endsWith("/publication.json")
				? jsonResponse({
						version: 2,
						revision,
						generatedAt: "2026-09-05T00:00:00Z",
						providers: ["xai"],
						shards: { xai: hash },
					})
				: jsonResponse(shard),
		);
		const result = await loadOfficialCatalog({
			allowNetwork: true,
			providerIds: ["xai"],
			bundled: { version: 1, updatedAt: "", models: [] },
			fetchImpl,
		});
		expect(result.source).toBe("github");
		expect(result.catalog.updatedAt).toBe("2026-09-05T00:00:00Z");
		expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
			`${VERSIONED_CATALOG_URL}/publication.json`,
			`${VERSIONED_CATALOG_URL}/snapshots/${revision}/providers/xai.json`,
		]);
	});

	it("retains the last-good provider when a shard fails integrity validation", async () => {
		const fetchImpl = vi.fn(async (url) =>
			String(url).endsWith("/publication.json")
				? jsonResponse({
						version: 2,
						revision: `sha256-${"a".repeat(64)}`,
						providers: ["xai"],
						shards: { xai: "incorrect" },
					})
				: jsonResponse({ [grok47.id]: grok47 }),
		);
		const result = await loadOfficialCatalog({
			allowNetwork: true,
			providerIds: ["xai"],
			bundled: { version: 1, updatedAt: "", models: [grok46] },
			fetchImpl,
		});
		expect(result.catalog.models.map((row) => row.id)).toEqual([grok46.id]);
		expect(result.errors?.xai).toMatch(/checksum/);
	});
});

describe("parseOfficialCatalog", () => {
	it("parses the seeded document and ignores junk rows", () => {
		const parsed = parseOfficialCatalog({
			version: 1,
			updatedAt: "2026-08-15T00:00:00Z",
			models: [BUNDLED_OFFICIAL_CATALOG.models[0], { nope: true }, null],
		});
		expect(parsed?.models).toHaveLength(1);
		expect(parsed?.models[0]).toMatchObject({ id: "grok-4.6", provider: "xai", contextWindow: 500000 });
	});

	it("parses keyed models.json and keeps compat + thinkingLevelMap", () => {
		const parsed = parseOfficialCatalog({
			xai: { "grok-4.7": grok47 },
			anthropic: {
				"claude-opus": {
					id: "claude-opus",
					name: "Claude Opus",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					contextWindow: 200000,
					maxTokens: 32000,
					compat: { supportsFineGrainedToolStreaming: false },
					thinkingLevelMap: { max: "max" },
				},
			},
		});
		expect(parsed?.models).toHaveLength(2);
		const grok = parsed?.models.find((model) => model.id === "grok-4.7");
		const claude = parsed?.models.find((model) => model.id === "claude-opus");
		expect(grok?.compat).toEqual({ thinkingFormat: "openrouter", supportsStore: false });
		expect(grok?.thinkingLevelMap).toEqual({ high: "high", low: "low" });
		expect(claude?.compat).toEqual({ supportsFineGrainedToolStreaming: false });
		expect(claude?.thinkingLevelMap).toEqual({ max: "max" });
	});

	it("parses a provider shard keyed by model id", () => {
		const parsed = parseOfficialCatalog({ "grok-4.7": grok47, junk: { nope: true } });
		expect(parsed?.models).toHaveLength(1);
		expect(parsed?.models[0]?.id).toBe("grok-4.7");
		expect(parsed?.models[0]?.compat).toEqual({ thinkingFormat: "openrouter", supportsStore: false });
	});

	it("fills provider/id from keyed maps when the row omits them", () => {
		const parsed = parseOfficialCatalog({
			xai: { "grok-4.6": { ...grok46, id: undefined, provider: undefined } },
		});
		expect(parsed?.models[0]).toMatchObject({ id: "grok-4.6", provider: "xai" });
	});

	it("returns undefined for a wrong shape", () => {
		expect(parseOfficialCatalog({ models: "nope" })).toBeUndefined();
		expect(parseOfficialCatalog(null)).toBeUndefined();
		expect(parseOfficialCatalog({})).toBeUndefined();
	});
});

describe("officialEntryToModel", () => {
	it("uses compat and thinkingLevelMap from the official row, not only the template", () => {
		const template: Model<"openai-completions"> = {
			...grok46,
			compat: { thinkingFormat: "openai" },
			thinkingLevelMap: { high: "template" },
		};
		const model = officialEntryToModel(
			{
				...grok47,
				api: "openai-completions",
			},
			template,
		);
		expect(model.compat).toEqual({ thinkingFormat: "openrouter", supportsStore: false });
		expect(model.thinkingLevelMap).toEqual({ high: "high", low: "low" });
	});

	it("falls back to the baked-in template when the official row has no compat", () => {
		const template: Model<"openai-completions"> = {
			...grok46,
			compat: { thinkingFormat: "openai" },
			thinkingLevelMap: { high: "template" },
		};
		const model = officialEntryToModel(grok46, template);
		expect(model.compat).toEqual({ thinkingFormat: "openai" });
		expect(model.thinkingLevelMap).toEqual({ high: "template" });
	});
});

describe("loadOfficialCatalog", () => {
	it("uses the bundled catalog when network is disabled", async () => {
		const fetchImpl = vi.fn();
		const loaded = await loadOfficialCatalog({
			allowNetwork: false,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			providerIds: ["xai"],
		});
		expect(loaded.source).toBe("bundled");
		expect(loaded.catalog.models.map((model) => model.id)).toEqual(["grok-4.6"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("prefers a cache file over bundled models.json when network is disabled", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		const cachedOnly = {
			id: "cached-only",
			name: "Cached Only",
			api: "openai-completions" as const,
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		writeFileSync(
			cachePath,
			`${JSON.stringify({ version: 1, updatedAt: "2026-08-17T00:00:00Z", models: [cachedOnly] })}\n`,
		);
		const loaded = await loadOfficialCatalog({
			allowNetwork: false,
			cachePath,
			bundled: {
				version: 1,
				updatedAt: "2026-01-01T00:00:00Z",
				models: [
					{
						...cachedOnly,
						id: "bundled-only",
						name: "Bundled Only",
					},
				],
			},
		});
		expect(loaded.source).toBe("cache");
		expect(loaded.catalog.models.map((model) => model.id)).toEqual(["cached-only"]);
	});

	it("falls back to bundled on 404 and timeout", async () => {
		const loaded404 = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			providerIds: ["xai"],
			fetchImpl: async () => new Response("missing", { status: 404 }),
		});
		expect(loaded404.source).toBe("bundled");
		expect(loaded404.catalog.models[0]?.id).toBe("grok-4.6");

		const loadedTimeout = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			providerIds: ["xai"],
			timeoutMs: 20,
			fetchImpl: () => new Promise(() => {}),
		});
		expect(loadedTimeout.source).toBe("bundled");
	});

	it("merges a successful shard into cache and keeps failed providers", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		const openaiCached = {
			id: "gpt-cached",
			name: "GPT Cached",
			api: "openai-completions" as const,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		writeFileSync(
			cachePath,
			`${JSON.stringify({ version: 1, updatedAt: "2026-08-15T00:00:00Z", models: [grok46, openaiCached] })}\n`,
		);
		const fetchImpl = vi.fn(
			shardFetch({
				"/providers.json": ["xai", "anthropic", "openai"],
				"/providers/xai.json": { "grok-4.7": grok47 },
				"/providers/openai.json": 404,
			}),
		);
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			cachePath,
			providerIds: ["xai", "openai"],
			fetchImpl,
		});
		expect(loaded.source).toBe("github");
		expect(loaded.catalog.models.map((model) => `${model.provider}/${model.id}`).sort()).toEqual([
			"openai/gpt-cached",
			"xai/grok-4.7",
		]);
		expect(loaded.catalog.models.find((model) => model.id === "grok-4.7")?.compat).toEqual({
			thinkingFormat: "openrouter",
			supportsStore: false,
		});
		expect(
			JSON.parse(readFileSync(cachePath, "utf-8"))
				.models.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`)
				.sort(),
		).toEqual(["openai/gpt-cached", "xai/grok-4.7"]);
		const urls = fetchImpl.mock.calls.map((call) => String(call[0])).sort();
		expect(urls).toEqual(
			[
				officialCatalogUrlFor("providers.json"),
				`${VERSIONED_CATALOG_URL}/publication.json`,
				officialCatalogUrlFor("providers/openai.json"),
				officialCatalogUrlFor("providers/xai.json"),
			].sort(),
		);
	});

	it("honors LUNR_OFFICIAL_CATALOG_URL as a directory base", async () => {
		vi.stubEnv("LUNR_OFFICIAL_CATALOG_URL", "https://example.test/catalog/");
		const fetchImpl = vi.fn(
			shardFetch({
				"/providers.json": ["xai"],
				"/providers/xai.json": { "grok-4.7": grok47 },
			}),
		);
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			providerIds: ["xai"],
			fetchImpl,
		});
		expect(loaded.source).toBe("github");
		expect(fetchImpl.mock.calls.map((call) => String(call[0])).sort()).toEqual([
			"https://example.test/catalog/providers.json",
			"https://example.test/catalog/providers/xai.json",
		]);
	});

	it("does not write cache when every requested shard fails", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		writeFileSync(cachePath, `${JSON.stringify(githubCatalog)}\n`);
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			cachePath,
			providerIds: ["xai"],
			fetchImpl: shardFetch({
				"/providers.json": ["xai"],
				"/providers/xai.json": 404,
			}),
		});
		expect(loaded.source).toBe("cache");
		expect(loaded.catalog.models[0]?.id).toBe("grok-4.7");
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).models[0].id).toBe("grok-4.7");
	});

	it("falls back to last cache when bundled is empty and GitHub fails", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		writeFileSync(cachePath, `${JSON.stringify(githubCatalog)}\n`);
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: { version: 1, updatedAt: "", models: [] },
			cachePath,
			providerIds: ["xai"],
			fetchImpl: async () => new Response("nope", { status: 500 }),
		});
		expect(loaded.source).toBe("cache");
		expect(loaded.catalog.models[0]?.id).toBe("grok-4.7");
	});
});
