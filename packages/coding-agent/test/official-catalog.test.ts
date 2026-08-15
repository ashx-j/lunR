import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_OFFICIAL_CATALOG, loadOfficialCatalog, parseOfficialCatalog } from "../src/core/official-catalog.ts";

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

const githubCatalog = {
	version: 1,
	updatedAt: "2026-08-16T00:00:00Z",
	models: [
		{
			id: "grok-4.7",
			name: "Grok 4.7",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 9, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 600000,
			maxTokens: 600000,
		},
	],
};

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

	it("returns undefined for a wrong shape", () => {
		expect(parseOfficialCatalog({ models: "nope" })).toBeUndefined();
		expect(parseOfficialCatalog(null)).toBeUndefined();
	});
});

describe("loadOfficialCatalog", () => {
	it("uses the bundled catalog when network is disabled", async () => {
		const fetchImpl = vi.fn();
		const loaded = await loadOfficialCatalog({
			allowNetwork: false,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(loaded.source).toBe("bundled");
		expect(loaded.catalog.models.map((model) => model.id)).toEqual(["grok-4.6"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("falls back to bundled on 404 and timeout", async () => {
		const loaded404 = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			fetchImpl: async () => new Response("missing", { status: 404 }),
		});
		expect(loaded404.source).toBe("bundled");
		expect(loaded404.catalog.models[0]?.id).toBe("grok-4.6");

		const loadedTimeout = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			timeoutMs: 20,
			fetchImpl: () => new Promise(() => {}),
		});
		expect(loadedTimeout.source).toBe("bundled");
	});

	it("replaces the bundled catalog with a GitHub payload and caches it", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			cachePath,
			fetchImpl: async () =>
				new Response(JSON.stringify(githubCatalog), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		expect(loaded.source).toBe("github");
		expect(loaded.catalog.models.map((model) => model.id)).toEqual(["grok-4.7"]);
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).models[0].id).toBe("grok-4.7");
	});

	it("honors LUNR_OFFICIAL_CATALOG_URL", async () => {
		vi.stubEnv("LUNR_OFFICIAL_CATALOG_URL", "https://example.test/official.json");
		const fetchImpl = vi.fn(async (url: string | URL) => {
			expect(String(url)).toBe("https://example.test/official.json");
			return new Response(JSON.stringify(githubCatalog), { status: 200 });
		});
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: BUNDLED_OFFICIAL_CATALOG,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(loaded.source).toBe("github");
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("falls back to last cache when bundled is empty and GitHub fails", async () => {
		const dir = tempDir();
		const cachePath = join(dir, "official-catalog-cache.json");
		writeFileSync(cachePath, `${JSON.stringify(githubCatalog)}\n`);
		const loaded = await loadOfficialCatalog({
			allowNetwork: true,
			bundled: { version: 1, updatedAt: "", models: [] },
			cachePath,
			fetchImpl: async () => new Response("nope", { status: 500 }),
		});
		expect(loaded.source).toBe("cache");
		expect(loaded.catalog.models[0]?.id).toBe("grok-4.7");
	});
});
