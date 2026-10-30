/** Catalog rows the generator adds because no public source lists them yet. */
import type { Api, Model } from "../src/types.ts";

/** Models no public source lists yet. Each entry should go once a source carries it. */
export const EXTRA_MODELS: readonly Model<Api>[] = [
	{
		id: "gpt-5-chat-latest",
		name: "GPT-5 Chat Latest",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	// OpenRouter routers. Their price depends on the model they pick, so it is unknown here.
	{
		id: "auto",
		name: "Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2000000,
		maxTokens: 30000,
	},
	{
		// Fusion's own metadata lists no tools, but it resolves to models that call caller tools.
		id: "openrouter/fusion",
		name: "OpenRouter: Fusion",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 30000,
	},
];
