import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { MODELS_DEV_PROVIDERS } from "@earendil-works/pi-ai/catalog/generic-providers";
import { ModelsDevFacts } from "@earendil-works/pi-ai/catalog/models-dev";
import { describe, expect, it, vi } from "vitest";
import {
	discoverLiveModels,
	fetchLiveProviderModels,
	isLiveModelIncomplete,
	LIVE_LIST_REJECTED,
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
	it("does not mistake missing or negative router prices for free models", () => {
		const models = discoverLiveModels(
			"openrouter",
			{
				data: [
					{ id: "missing-price", supported_parameters: ["tools"] },
					{ id: "dynamic-price", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
					{ id: "free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
				],
			},
			[template("openrouter")],
		);
		expect(models.slice(0, 2).map((row) => row.model.catalog?.pricing)).toEqual(["unknown", "unknown"]);
		expect(models[2].model.catalog?.pricing).toBeUndefined();
		expect(models.every((row) => row.model.cost.input >= 0)).toBe(true);
	});

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

	it("gives a new OpenAI id the settings models.dev facts describe", () => {
		const gpt4 = { ...template("openai"), id: "gpt-4o", api: "openai-responses" as const, reasoning: false };
		const facts = ModelsDevFacts.fromIndex({
			"gpt-7": {
				tool_call: true,
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
				limit: { context: 1000000, output: 128000 },
			},
		});
		const [discovery] = discoverLiveModels("openai", { data: [{ id: "gpt-7" }] }, [gpt4], { facts });
		expect(discovery.model).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
		});
		expect(getSupportedThinkingLevels(discovery.model)).toEqual(["off", "low", "medium", "high", "xhigh"]);
	});

	it("starts a new id without facts with no thinking controls and 128k context", () => {
		const [discovery] = discoverLiveModels("deepseek", { data: [{ id: "deepseek-v9" }] }, [
			{ ...template("deepseek"), id: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
		]);
		expect(discovery.model).toMatchObject({ reasoning: false, contextWindow: 128000, maxTokens: 8192 });
		expect(discovery.model.catalog?.pricing).toBe("unknown");
	});

	it("reads Claude capabilities from Anthropic's list and applies catalog rules", () => {
		const claude = { ...template("anthropic"), id: "claude-sonnet-4-6", api: "anthropic-messages" as const };
		const capabilities = (levels: string[]) => ({
			image_input: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
			effort: Object.fromEntries(levels.map((level) => [level, { supported: true }])),
		});
		const discoveries = discoverLiveModels(
			"anthropic",
			{
				data: [
					{
						id: "claude-opus-9",
						display_name: "Claude Opus 9",
						max_input_tokens: 2000000,
						max_tokens: 256000,
						capabilities: capabilities(["low", "medium", "high", "xhigh", "max"]),
					},
					{
						id: "claude-opus-5-5",
						max_input_tokens: 1000000,
						max_tokens: 128000,
						capabilities: capabilities(["low", "max"]),
					},
				],
			},
			[claude],
		);
		const [opus9, opus55] = discoveries.map((entry) => entry.model);
		expect(opus9).toMatchObject({
			name: "Claude Opus 9",
			api: "anthropic-messages",
			contextWindow: 2000000,
			input: ["text", "image"],
			compat: { forceAdaptiveThinking: true },
		});
		expect(getSupportedThinkingLevels(opus9)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		// The rule for models that reject disabled thinking still applies.
		expect(getSupportedThinkingLevels(opus55)).not.toContain("off");
	});

	it("reads Gemini models that generate content from Google's list", () => {
		const gemini = {
			...template("google"),
			id: "gemini-3.5-flash",
			api: "google-generative-ai" as const,
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		};
		const discoveries = discoverLiveModels(
			"google",
			{
				models: [
					{
						name: "models/gemini-9-pro",
						displayName: "Gemini 9 Pro",
						inputTokenLimit: 2097152,
						outputTokenLimit: 65536,
						thinking: true,
						supportedGenerationMethods: ["generateContent", "countTokens"],
					},
					{ name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] },
				],
			},
			[gemini],
		);
		expect(discoveries.map((entry) => entry.model.id)).toEqual(["gemini-9-pro"]);
		expect(discoveries[0]?.model).toMatchObject({ contextWindow: 2097152, reasoning: true });
	});

	it("skips new speech, image and embedding ids but keeps catalog ones", () => {
		const groq = { ...template("groq"), id: "whisper-large-v3", baseUrl: "https://api.groq.com/openai/v1" };
		const ids = discoverLiveModels(
			"groq",
			{ data: [{ id: "whisper-large-v3" }, { id: "playai-tts" }, { id: "llama-guard-5" }, { id: "kimi-k9" }] },
			[groq],
		).map((entry) => entry.model.id);
		expect(ids).toEqual(["whisper-large-v3", "kimi-k9"]);
	});

	it("skips new ids models.dev knows cannot call tools", () => {
		const gemini = { ...template("google"), id: "gemini-3.5-flash", api: "google-generative-ai" as const };
		const facts = ModelsDevFacts.fromIndex({ "gemma-9-1b-it": { tool_call: false } });
		const listed = (name: string) => ({ name: `models/${name}`, supportedGenerationMethods: ["generateContent"] });
		const ids = discoverLiveModels(
			"google",
			{ models: [listed("gemma-9-1b-it"), listed("gemini-9-pro")] },
			[gemini],
			{
				facts,
			},
		).map((entry) => entry.model.id);
		expect(ids).toEqual(["gemini-9-pro"]);
	});

	it("discovers models for a generic models.dev provider with no baked-in rows", () => {
		const definition = MODELS_DEV_PROVIDERS.find((candidate) => candidate.api === "openai-completions")!;
		const [discovery] = discoverLiveModels(definition.id, { data: [{ id: "brand-new-model" }] }, []);
		expect(discovery.model).toMatchObject({
			provider: definition.id,
			api: "openai-completions",
			baseUrl: definition.baseUrl,
		});
	});

	it("stays quiet when a provider has no list endpoint", async () => {
		const result = await fetchLiveProviderModels({
			providerId: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			bakedIn: [{ ...template("zai"), id: "glm-5.3" }],
			credential: { type: "api_key", key: "test-key" },
			knownKeys: new Set(),
			fetchImpl: async () => new Response("not found", { status: 404 }),
		});
		expect(result).toMatchObject({ status: "skipped", error: "model list unavailable (HTTP 404)" });
	});

	it("reports a refused login without treating it as a missing list", async () => {
		const result = await fetchLiveProviderModels({
			providerId: "xai",
			baseUrl: "https://api.x.ai/v1",
			bakedIn: [template()],
			credential: { type: "api_key", key: "revoked" },
			knownKeys: new Set(),
			fetchImpl: async () => new Response("unauthorized", { status: 401 }),
		});
		expect(result).toMatchObject({ status: "error", error: `${LIVE_LIST_REJECTED} (HTTP 401)` });
	});

	it("loads models.dev facts only when the list names a new id", async () => {
		const getFacts = vi.fn(async () => undefined);
		const options = {
			providerId: "xai",
			baseUrl: "https://api.x.ai/v1",
			bakedIn: [template()],
			credential: { type: "api_key" as const, key: "test-key" },
			knownKeys: new Set<string>(),
			getFacts,
		};
		await fetchLiveProviderModels({
			...options,
			fetchImpl: async () => Response.json({ data: [{ id: "grok-4.3" }] }),
		});
		expect(getFacts).not.toHaveBeenCalled();
		await fetchLiveProviderModels({ ...options, fetchImpl: async () => Response.json({ data: [{ id: "grok-9" }] }) });
		expect(getFacts).toHaveBeenCalledOnce();
	});

	it("discovers new xAI ids from a live list payload", () => {
		const discoveries = discoverLiveModels("xai", { data: [{ id: "grok-4.6" }, { id: "grok-4.3" }] }, [template()]);
		expect(discoveries.map((entry) => entry.model.id)).toEqual(["grok-4.6", "grok-4.3"]);
		expect(discoveries[0]?.supplied.contextWindow).toBe(false);
	});
});
