import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/compat.ts";
import {
	parseOpenAiGptVersion,
	supportsOpenAiMax,
	supportsOpenAiXhigh,
	withOpenAiEffortMetadata,
} from "../src/openai-effort.ts";
import type { Api, Model } from "../src/types.ts";

const catalogProvidersPath = join(dirname(fileURLToPath(import.meta.url)), "../../../catalog/providers");

function loadCatalogProvider(provider: string): Record<string, Model<Api>> {
	return JSON.parse(readFileSync(join(catalogProvidersPath, `${provider}.json`), "utf8")) as Record<
		string,
		Model<Api>
	>;
}

describe("parseOpenAiGptVersion", () => {
	it("parses dotted and named gpt ids", () => {
		expect(parseOpenAiGptVersion("gpt-5.2")).toEqual({ major: 5, minor: 2 });
		expect(parseOpenAiGptVersion("gpt-5.6-sol")).toEqual({ major: 5, minor: 6 });
		expect(parseOpenAiGptVersion("gpt-6-astra")).toEqual({ major: 6, minor: 0 });
		expect(parseOpenAiGptVersion("openai/gpt-6-astra")).toEqual({ major: 6, minor: 0 });
		expect(parseOpenAiGptVersion("gpt-5.3-codex")).toEqual({ major: 5, minor: 3 });
	});

	it("ignores non-gpt ids", () => {
		expect(parseOpenAiGptVersion("o3")).toBeUndefined();
		expect(parseOpenAiGptVersion("grok-4.6")).toBeUndefined();
	});
});

describe("OpenAI effort floors", () => {
	it("is a version floor, not a frozen gpt-5.6 id", () => {
		expect(supportsOpenAiXhigh("gpt-5")).toBe(false);
		expect(supportsOpenAiXhigh("gpt-5.1")).toBe(false);
		expect(supportsOpenAiXhigh("gpt-5.2")).toBe(true);
		expect(supportsOpenAiXhigh("gpt-6-astra")).toBe(true);
		expect(supportsOpenAiMax("gpt-5.5")).toBe(false);
		expect(supportsOpenAiMax("gpt-5.6-terra")).toBe(true);
		expect(supportsOpenAiMax("gpt-6-astra")).toBe(true);
		expect(supportsOpenAiMax("gpt-7-flagship")).toBe(true);
	});
});

describe("withOpenAiEffortMetadata", () => {
	it("stamps gpt-6 xhigh/max and reasoning onto a live completions-style row", () => {
		const stamped = withOpenAiEffortMetadata({
			id: "gpt-6-astra",
			provider: "openai",
			api: "openai-responses",
			reasoning: false,
		});
		expect(stamped.reasoning).toBe(true);
		expect(stamped.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("does not clobber gpt-5.6 none-reasoning off", () => {
		const stamped = withOpenAiEffortMetadata({
			id: "gpt-5.6-sol",
			provider: "openai",
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		});
		expect(stamped.thinkingLevelMap).toEqual({ off: "none", xhigh: "xhigh", max: "max" });
	});

	it("does not stamp models routed through unrelated providers", () => {
		const model = {
			id: "openai/gpt-6-astra",
			provider: "openrouter",
			api: "openai-completions",
			reasoning: false,
		};
		expect(withOpenAiEffortMetadata(model)).toBe(model);
	});
});

describe("GPT-6 catalogs", () => {
	const newModels = {
		"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	} as const;

	it("keeps every baked Codex model on its audited default window", () => {
		expect(Object.fromEntries(getModels("openai-codex").map((model) => [model.id, model.contextWindow]))).toEqual({
			"gpt-5.3-codex-spark": 128000,
			"gpt-5.4": 272000,
			"gpt-5.4-mini": 272000,
			"gpt-5.5": 272000,
			"gpt-5.6-luna": 272000,
			"gpt-5.6-sol": 272000,
			"gpt-5.6-terra": 272000,
			"gpt-6-astra": 272000,
			"gpt-6-luna": 272000,
			"gpt-6-sol": 272000,
			"gpt-6.1-sol": 272000,
		});
	});

	it("keeps GPT-6.1 Sol's Codex limits, prices, and supported efforts current", () => {
		const model = getModel("openai-codex", "gpt-6.1-sol");
		expect(model).toMatchObject({
			api: "openai-codex-responses",
			reasoning: true,
			contextWindow: 272000,
			maxTokens: 128000,
			input: ["text", "image"],
			compat: { supportsToolSearch: true },
			cost: {
				input: 2,
				output: 10,
				cacheRead: 0.1,
				cacheWrite: 2.5,
				tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
			},
			thinkingLevelMap: { off: null, minimal: null },
			catalog: { hidden: false, reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
		});
		expect(model?.catalog?.pricing).toBeUndefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(loadCatalogProvider("openai-codex")["gpt-6.1-sol"]).toEqual(model);
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
		"keeps the Codex default window for %s at 272k",
		(modelId) => {
			expect(getModel("openai-codex", modelId)?.contextWindow).toBe(272000);
			expect(loadCatalogProvider("openai-codex")[modelId]?.contextWindow).toBe(272000);
		},
	);

	it.each(Object.entries(newModels))("matches official specs for %s", (modelId, baseCost) => {
		const direct = getModel("openai", modelId)!;
		const codex = getModel("openai-codex", modelId)!;
		const expectedCost = {
			...baseCost,
			tiers: [
				{
					inputTokensAbove: 272000,
					input: baseCost.input * 2,
					output: baseCost.output * 1.5,
					cacheRead: baseCost.cacheRead * 2,
					cacheWrite: baseCost.cacheWrite * 2,
				},
			],
		};

		expect(direct).toMatchObject({ reasoning: true, contextWindow: 1050000, maxTokens: 128000, cost: expectedCost });
		expect(codex).toMatchObject({ reasoning: true, contextWindow: 272000, maxTokens: 128000, cost: expectedCost });
		expect(loadCatalogProvider("openai")[modelId]).toMatchObject(direct);
		expect(loadCatalogProvider("openai-codex")[modelId]).toMatchObject(codex);
		expect(loadCatalogProvider("azure-openai-responses")[modelId]).toMatchObject({
			contextWindow: 1050000,
			maxTokens: 128000,
			cost: baseCost,
		});
		expect(getSupportedThinkingLevels(direct)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(getSupportedThinkingLevels(codex)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each(["gpt-6-astra", ...Object.keys(newModels)])(
		"publishes %s in every official catalog shard used by refresh",
		(modelId) => {
			for (const provider of ["openai", "openai-codex", "azure-openai-responses"]) {
				const model = loadCatalogProvider(provider)[modelId];
				expect(model).toBeDefined();
				expect(model.provider).toBe(provider);
				expect(model.contextWindow).toBe(provider === "openai-codex" ? 272000 : 1050000);
				expect(model.maxTokens).toBe(128000);
				if (provider !== "azure-openai-responses") {
					expect(model.compat).toMatchObject({ supportsToolSearch: true });
				}
				const supportsNone = modelId !== "gpt-6-astra" && provider !== "openai-codex";
				expect(getSupportedThinkingLevels(model)).toEqual(
					supportsNone
						? ["off", "low", "medium", "high", "xhigh", "max"]
						: ["low", "medium", "high", "xhigh", "max"],
				);
			}
		},
	);
});
