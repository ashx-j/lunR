import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	discoverLiveModels,
	fetchLiveProviderModels,
	isLiveModelIncomplete,
	mapOpenRouterModel,
	parseOpenAIModelsList,
	synthesizeLiveModel,
} from "../src/core/live-catalog.ts";

function template(provider = "xai"): Model<"openai-completions"> {
	return {
		id: "grok-4.3",
		name: "Grok 4.3",
		api: "openai-completions",
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 30000,
	};
}

describe("live-catalog", () => {
	it("parses an OpenAI { data: [{ id }] } list", () => {
		expect(
			parseOpenAIModelsList({ data: [{ id: "grok-4.6" }, { id: "grok-4.3" }, { nope: 1 }] }).map((row) => row.id),
		).toEqual(["grok-4.6", "grok-4.3"]);
	});

	it("treats an OpenRouter-rich row as complete (no prompt)", () => {
		const mapped = mapOpenRouterModel(
			{
				id: "openai/gpt-4o",
				name: "GPT-4o",
				supported_parameters: ["tools", "reasoning"],
				architecture: { modality: "text+image" },
				pricing: {
					prompt: "0.000002",
					completion: "0.000006",
					input_cache_read: "0.0000005",
					input_cache_write: "0",
				},
				context_length: 128000,
				top_provider: { context_length: 128000, max_completion_tokens: 16384 },
			},
			{ ...template("openrouter"), provider: "openrouter" },
		);
		expect(mapped).toBeDefined();
		expect(isLiveModelIncomplete(mapped!, new Set())).toBe(false);
		expect(mapped?.model.cost.input).toBe(2);
		expect(mapped?.model.cost.output).toBe(6);
		expect(mapped?.model.input).toEqual(["text", "image"]);
		expect(mapped?.supplied.contextWindow).toBe(true);
		expect(mapped?.supplied.maxTokens).toBe(true);
		expect(mapped?.supplied.input).toBe(true);
	});

	it("drops OpenRouter rows that do not advertise tools", () => {
		expect(
			mapOpenRouterModel(
				{ id: "no-tools", supported_parameters: ["temperature"], context_length: 8000 },
				{ ...template("openrouter"), provider: "openrouter" },
			),
		).toBeUndefined();
	});

	it("treats an xAI id-only row as incomplete", () => {
		const discovery = synthesizeLiveModel("grok-4.6", template());
		expect(isLiveModelIncomplete(discovery, new Set())).toBe(true);
		expect(isLiveModelIncomplete(discovery, new Set(["xai/grok-4.6"]))).toBe(false);
		expect(discovery.model.api).toBe("openai-completions");
		expect(discovery.model.compat).toEqual(template().compat);
	});

	it("does not throw when the live fetch hangs", async () => {
		const result = await fetchLiveProviderModels({
			providerId: "xai",
			baseUrl: "https://api.x.ai/v1",
			bakedIn: [template()],
			credential: { type: "api_key", key: "test-key" },
			knownKeys: new Set(),
			timeoutMs: 20,
			fetchImpl: () => new Promise(() => {}),
		});
		expect(result.status).toBe("timeout");
		expect(result.incomplete).toEqual([]);
	});

	it("discovers new xAI ids from a live list payload", () => {
		const discoveries = discoverLiveModels("xai", { data: [{ id: "grok-4.6" }, { id: "grok-4.3" }] }, [template()]);
		expect(discoveries.map((entry) => entry.model.id)).toEqual(["grok-4.6", "grok-4.3"]);
		expect(discoveries[0]?.supplied.contextWindow).toBe(false);
	});
});
