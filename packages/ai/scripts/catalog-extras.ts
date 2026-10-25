/** Catalog rows the generator adds because no public source lists them yet. */
import type { Api, Model } from "../src/types.ts";

/** Models no public source lists yet. Each entry should go once a source carries it. */
export const EXTRA_MODELS: readonly Model<Api>[] = [
	...(
		[
			["Ling-2.6-flash", "Ling 2.6 Flash", false, 0.01, 0.02],
			["Ling-2.6-1T", "Ling 2.6 1T", false, 0.06, 0.25],
			["Ring-2.6-1T", "Ring 2.6 1T", true, 0.06, 0.25],
		] as const
	).map(
		([id, name, reasoning, input, output]): Model<"openai-completions"> => ({
			id,
			name,
			api: "openai-completions",
			provider: "ant-ling",
			baseUrl: "https://api.ant-ling.com/v1",
			reasoning,
			input: ["text"],
			cost: { input, output, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			// Ring reasons by default; only high and xhigh have documented effort controls.
			...(reasoning
				? {
						thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" },
					}
				: {}),
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsLongCacheRetention: false,
				...(reasoning ? { thinkingFormat: "ant-ling" as const } : {}),
			},
		}),
	),
	{
		id: "mistral-medium-3.5",
		name: "Mistral Medium 3.5",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 262144,
	},
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
