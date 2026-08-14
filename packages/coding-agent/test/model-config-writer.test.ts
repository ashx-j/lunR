import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isValidProviderBaseUrl,
	parseModelIds,
	slugifyProviderId,
	upsertCustomProvider,
} from "../src/core/model-config-writer.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true });
	}
});

function tempDir(): string {
	const dir = join(tmpdir(), `lunr-model-config-writer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("upsertCustomProvider", () => {
	it("creates a fresh models.json when none exists", async () => {
		const path = join(tempDir(), "nested", "models.json");
		await upsertCustomProvider(path, "my-provider", {
			name: "My Provider",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [{ id: "model-a" }],
		});

		const raw = readFileSync(path, "utf-8");
		expect(raw.endsWith("}\n")).toBe(true);
		expect(JSON.parse(raw)).toEqual({
			providers: {
				"my-provider": {
					name: "My Provider",
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					models: [{ id: "model-a" }],
				},
			},
		});
	});

	it("merges into an existing file, preserving other providers and key order", async () => {
		const path = join(tempDir(), "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"first-provider": { baseUrl: "https://one.example.com", models: [{ id: "m1" }] },
					"third-provider": { baseUrl: "https://three.example.com", models: [{ id: "m3" }] },
				},
			}),
		);

		await upsertCustomProvider(path, "second-provider", {
			baseUrl: "https://two.example.com",
			models: [{ id: "m2" }],
		});

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(Object.keys(parsed.providers)).toEqual(["first-provider", "third-provider", "second-provider"]);
		expect(parsed.providers["first-provider"]).toEqual({
			baseUrl: "https://one.example.com",
			models: [{ id: "m1" }],
		});
		expect(parsed.providers["second-provider"].baseUrl).toBe("https://two.example.com");
	});

	it("replaces the same provider key in place", async () => {
		const path = join(tempDir(), "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					alpha: { baseUrl: "https://alpha.example.com", models: [{ id: "old" }] },
					beta: { baseUrl: "https://beta.example.com", models: [{ id: "keep" }] },
				},
			}),
		);

		await upsertCustomProvider(path, "alpha", {
			baseUrl: "https://alpha-v2.example.com",
			api: "anthropic-messages",
			models: [{ id: "new" }],
		});

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(Object.keys(parsed.providers)).toEqual(["alpha", "beta"]);
		expect(parsed.providers.alpha).toEqual({
			baseUrl: "https://alpha-v2.example.com",
			api: "anthropic-messages",
			models: [{ id: "new" }],
		});
		expect(parsed.providers.beta.models).toEqual([{ id: "keep" }]);
	});

	it("throws on invalid existing JSON instead of dropping the file", async () => {
		const path = join(tempDir(), "models.json");
		writeFileSync(path, "{ not json");

		await expect(
			upsertCustomProvider(path, "x", { baseUrl: "https://x.example.com", models: [{ id: "m" }] }),
		).rejects.toThrow(/not valid JSON/);
		// The original file content is untouched.
		expect(readFileSync(path, "utf-8")).toBe("{ not json");
	});

	it("throws when the existing file has the wrong shape", async () => {
		const path = join(tempDir(), "models.json");
		writeFileSync(path, JSON.stringify({ providers: ["not-a-record"] }));

		await expect(
			upsertCustomProvider(path, "x", { baseUrl: "https://x.example.com", models: [{ id: "m" }] }),
		).rejects.toThrow(/"providers" record/);
	});
});

describe("slugifyProviderId", () => {
	it("normalizes case, spaces, and symbols", () => {
		expect(slugifyProviderId("My Provider", [])).toBe("my-provider");
		expect(slugifyProviderId("  ACME__AI (v2)! ", [])).toBe("acme-ai-v2");
		expect(slugifyProviderId("openrouter", [])).toBe("openrouter");
	});

	it("falls back to 'custom' when nothing alphanumeric remains", () => {
		expect(slugifyProviderId("…", [])).toBe("custom");
	});

	it("dedups against existing ids with numeric suffixes", () => {
		expect(slugifyProviderId("My Provider", ["my-provider"])).toBe("my-provider-2");
		expect(slugifyProviderId("My Provider", ["my-provider", "my-provider-2"])).toBe("my-provider-3");
	});
});

describe("isValidProviderBaseUrl", () => {
	it("accepts absolute http(s) URLs", () => {
		expect(isValidProviderBaseUrl("https://api.example.com/v1")).toBe(true);
		expect(isValidProviderBaseUrl("http://localhost:11434/v1")).toBe(true);
		expect(isValidProviderBaseUrl("  https://api.example.com  ")).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isValidProviderBaseUrl("")).toBe(false);
		expect(isValidProviderBaseUrl("api.example.com")).toBe(false);
		expect(isValidProviderBaseUrl("ftp://api.example.com")).toBe(false);
		expect(isValidProviderBaseUrl("https://")).toBe(false);
	});
});

describe("parseModelIds", () => {
	it("trims entries, drops empties, and dedups", () => {
		expect(parseModelIds("model-a, model-b ,model-c")).toEqual(["model-a", "model-b", "model-c"]);
		expect(parseModelIds("model-a,, model-a, ,")).toEqual(["model-a"]);
		expect(parseModelIds(" , ")).toEqual([]);
	});
});
