import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatCatalogRefreshSummary, mergeCatalogLayers } from "../src/core/catalog-merge.ts";
import { evictUserModelsOnOfficial } from "../src/core/user-models.ts";

function model(id: string, layer: string, provider = "xai"): Model<"openai-completions"> {
	return {
		id,
		name: `${layer}:${id}`,
		api: "openai-completions",
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("catalog merge precedence", () => {
	it("applies official > user > live > baked-in", () => {
		const merged = mergeCatalogLayers({
			bakedIn: [model("a", "baked"), model("b", "baked"), model("c", "baked")],
			live: [model("b", "live"), model("d", "live")],
			user: [model("c", "user"), model("d", "user")],
			official: [model("d", "official")],
		});
		expect(merged.map((entry) => `${entry.id}:${entry.name}`)).toEqual([
			"a:baked:a",
			"b:live:b",
			"c:user:c",
			"d:official:d",
		]);
	});

	it("keeps baked-in models that a live list omitted", () => {
		const merged = mergeCatalogLayers({
			bakedIn: [model("grok-4.3", "baked"), model("grok-4.5", "baked")],
			live: [model("grok-4.6", "live")],
		});
		expect(merged.map((entry) => entry.id)).toEqual(["grok-4.3", "grok-4.5", "grok-4.6"]);
	});

	it("evicts a user row when official gains that id", () => {
		const user = {
			version: 1,
			models: [
				{
					id: "grok-4.6",
					name: "guess",
					api: "openai-completions" as const,
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					source: "user" as const,
				},
				{
					id: "keep-me",
					name: "keep",
					api: "openai-completions" as const,
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					source: "user" as const,
				},
			],
		};
		const { next, evicted } = evictUserModelsOnOfficial(user, ["xai/grok-4.6"]);
		expect(evicted.map((entry) => entry.id)).toEqual(["grok-4.6"]);
		expect(next.models.map((entry) => entry.id)).toEqual(["keep-me"]);

		const merged = mergeCatalogLayers({
			bakedIn: [model("grok-4.3", "baked")],
			user: next.models.map((entry) => model(entry.id, "user")),
			official: [model("grok-4.6", "official")],
		});
		expect(merged.find((entry) => entry.id === "grok-4.6")?.name).toBe("official:grok-4.6");
		expect(merged.find((entry) => entry.id === "keep-me")?.name).toBe("user:keep-me");
	});
});

describe("formatCatalogRefreshSummary", () => {
	it("does not count skipped live-list slots as refreshed providers", () => {
		expect(
			formatCatalogRefreshSummary({
				providers: [
					{ id: "xai", status: "error", error: "HTTP 403" },
					{ id: "openrouter", status: "skipped" },
					{ id: "qwen-cloud", status: "skipped" },
					{ id: "qwen-cloud-cn", status: "skipped" },
					{ id: "groq", status: "skipped" },
					{ id: "openai", status: "skipped" },
					{ id: "deepseek", status: "skipped" },
				],
			}),
		).toBe("xai failed (HTTP 403).");
	});

	it("lists successes then failures", () => {
		expect(
			formatCatalogRefreshSummary({
				providers: [
					{ id: "openai", status: "ok", total: 3 },
					{ id: "xai", status: "error", error: "HTTP 403" },
				],
			}),
		).toBe("Refreshed openai (3). xai failed (HTTP 403).");
	});

	it("reports a lone timeout without a provider count", () => {
		expect(
			formatCatalogRefreshSummary({
				providers: [{ id: "xai", status: "timeout", error: "timed out" }],
			}),
		).toBe("xai timed out (cached).");
	});

	it("maps a revoked xAI refresh to a re-login hint", () => {
		expect(
			formatCatalogRefreshSummary({
				providers: [{ id: "xai", status: "error", error: "OAuth refresh failed for xai" }],
			}),
		).toBe("xai login expired (run /login xai).");
	});
});
