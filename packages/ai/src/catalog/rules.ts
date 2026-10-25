import type { Api, Model, ModelCostRates, ThinkingLevelMap } from "../types.ts";

/**
 * Model facts the public sources get wrong or do not carry. The generator applies these to every
 * catalog row. A rule never decides whether a new model exists unless it says `drop` and explains why.
 */
export interface CatalogRule {
	/** lunR provider ids. Omit to apply to every provider. */
	providers?: readonly string[];
	/** Providers the rule skips. */
	notProviders?: readonly string[];
	/** Only models on this transport. */
	api?: Api;
	/** Exact model id, or a pattern tested against the id. */
	match: string | RegExp;
	/** Remove the model. */
	drop?: true;
	/** Fields to set. `thinkingLevelMap`, `compat` and `cost` merge into what is already there. */
	set?: CatalogPatch;
	/** Why the rule exists, so it can be deleted once the reason goes away. */
	why: string;
}

export interface CatalogPatch {
	api?: Api;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
	cost?: Partial<ModelCostRates>;
}

const CLAUDE_REJECTS_DISABLED_THINKING = /(?:opus|sonnet)[-.]5[-.]5|fable-5|mythos/;

export const CATALOG_RULES: readonly CatalogRule[] = [
	// Anthropic
	{
		match: CLAUDE_REJECTS_DISABLED_THINKING,
		set: { thinkingLevelMap: { off: null } },
		why: "Claude Opus 5.5, Sonnet 5.5, Fable 5 and Mythos return 400 for thinking type disabled.",
	},
	{
		providers: ["github-copilot"],
		match: /^claude-(?:haiku-4\.5|sonnet-4|sonnet-4\.5)$/,
		set: { compat: { supportsEagerToolInputStreaming: false } },
		why: "Copilot rejects per-tool eager_input_streaming for these older Claude models.",
	},
	{
		providers: ["github-copilot"],
		match: /^(?:claude-(?:opus-4\.[6-8]|sonnet-4\.6|sonnet-5|fable-5)|gpt-5\.3-codex|gpt-5\.[45])$/,
		set: { contextWindow: 1000000 },
		why: "GitHub lists these Copilot models with the extended 1M window; models.dev has the default.",
	},

	// OpenAI
	{
		providers: ["openai", "azure-openai-responses"],
		match: "gpt-5.6",
		drop: true,
		why: "models.dev lists this alias, but the OpenAI API does not accept it.",
	},
	{
		providers: ["openai", "openai-codex"],
		match: /^gpt-(?:5\.4(?:-mini|-pro)?|5\.5|5\.(?:[6-9]|\d{2,})(?:-.+)?|(?:[6-9]|\d{2,})(?:[.-].+)?)$/,
		set: { compat: { supportsToolSearch: true } },
		why: "GPT-5.4 and later run client-executed tool search for deferred tools; models.dev has no field for it.",
	},
	{
		providers: ["openai", "azure-openai-responses"],
		match: "gpt-5-pro",
		set: { maxTokens: 128000 },
		why: "models.dev repeats the 272000 input limit as the output limit; the real cap is 128000.",
	},

	// Google
	{
		providers: ["google", "google-vertex"],
		match: /^gemini-flash(?:-lite)?-latest$/,
		set: { thinkingLevelMap: { off: null } },
		why: "The -latest aliases point at Gemini 3 Flash models, which cannot turn thinking off.",
	},

	// xAI
	{
		providers: ["xai"],
		match: /^grok-4\.20(?:$|-)/,
		drop: true,
		why: "Grok 4.20 predates Grok 4.3, but lunR's Grok version check reads it as minor 20 and would send Grok 4.6 effort levels it does not take.",
	},
	{
		providers: ["xai"],
		match: /^grok-4\.5(?:$|-)/,
		set: { thinkingLevelMap: { xhigh: undefined } },
		why: "xAI accepts xhigh on Grok 4.5 but runs it as high, so the picker would show a duplicate level.",
	},

	// Z.ai
	{
		providers: ["zai", "zai-coding-cn"],
		match: /^glm-4\.5/,
		set: { compat: { zaiToolStream: false } },
		why: "GLM-4.5 models reject tool_stream.",
	},

	// Kimi and Moonshot
	{
		providers: ["kimi-coding"],
		match: /^k3\.1/,
		drop: true,
		why: "models.dev lists K3.1 only for api.kimi.ai, which lunR's Kimi endpoint has not been checked against.",
	},
	{
		providers: ["kimi-coding"],
		match: /^(?:k3|kimi-for-coding)$/,
		set: { compat: { allowEmptySignature: true } },
		why: "Kimi returns empty thinking signatures that must be replayed as-is.",
	},
	{
		providers: ["moonshotai", "moonshotai-cn"],
		match: "kimi-k3",
		set: { compat: { requiresReasoningContentOnAssistantMessages: true, deferredToolsMode: "kimi" } },
		why: "Kimi K3 needs reasoning_content replayed and its own deferred-tool format.",
	},

	// DeepSeek V4 served elsewhere
	{
		api: "openai-completions",
		match: /deepseek-v4/,
		notProviders: ["openrouter", "opencode", "qwen-token-plan", "qwen-token-plan-cn"],
		set: { compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" } },
		why: "DeepSeek V4 needs DeepSeek-style thinking and reasoning_content replay on OpenAI-compatible hosts.",
	},
	{
		providers: ["openrouter", "opencode"],
		match: /deepseek-v4/,
		set: { compat: { requiresReasoningContentOnAssistantMessages: true } },
		why: "OpenRouter and OpenCode keep their own effort format for DeepSeek V4 but still need reasoning_content replay.",
	},

	// OpenCode
	{
		providers: ["opencode", "opencode-go"],
		match: "gpt-5.3-codex-spark",
		drop: true,
		why: "Codex Spark is not served through OpenCode's API.",
	},
	{
		providers: ["opencode"],
		match: "grok-build-0.1",
		set: {
			compat: { supportsReasoningEffort: false },
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
		},
		why: "Grok Build reasons by default and rejects an explicit reasoning effort.",
	},
	{
		providers: ["opencode", "opencode-go"],
		match: "kimi-k2.6",
		set: { compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false } },
		why: "OpenCode's Kimi K2.6 takes Anthropic-style thinking objects and rejects reasoning_effort.",
	},
	{
		providers: ["opencode-go"],
		match: /^(?:minimax-m2\.7|qwen3\.[56]-plus)$/,
		set: {
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
			compat: { maxTokensField: "max_tokens" },
		},
		why: "models.dev marks these as Anthropic SDK models, but OpenCode Go serves them on chat completions.",
	},
	{
		providers: ["opencode-go"],
		match: "kimi-k2.6",
		set: { thinkingLevelMap: { minimal: null, low: null, medium: null } },
		why: "OpenCode Go exposes Kimi K2.6 thinking as on and off, not effort tiers.",
	},
	{
		providers: ["opencode-go"],
		match: /^qwen3\.[56]-plus$/,
		set: { compat: { thinkingFormat: "qwen" } },
		why: "Qwen on OpenCode Go switches thinking with enable_thinking.",
	},
	{
		providers: ["opencode", "opencode-go"],
		match: /^(?:deepseek-v4-(?:flash|pro)|kimi-k2\.[56]|minimax-m2\.7)$/,
		set: { compat: { supportsLongCacheRetention: false } },
		why: "OpenCode rejects 24h prompt cache retention for these chat-completions models.",
	},
	{
		providers: ["opencode", "opencode-go"],
		match: "gpt-5.4",
		set: { contextWindow: 272000, maxTokens: 128000 },
		why: "OpenCode serves GPT-5.4 in OpenAI's 272K base price tier.",
	},
	{
		providers: ["opencode", "opencode-go"],
		match: /^claude-sonnet-4(?:-5)?$/,
		set: { contextWindow: 200000 },
		why: "OpenCode lists Sonnet 4 and 4.5 with 1M context; the real limit is 200K.",
	},

	// OpenRouter and Vercel
	{
		providers: ["openrouter", "vercel-ai-gateway"],
		match: /^~?moonshotai\/kimi-(?:k3|latest)$/,
		set: { maxTokens: 131072 },
		why: "Gateways report a smaller output cap than Kimi K3's 131072.",
	},
	{
		providers: ["openrouter"],
		match: /^moonshotai\/kimi-k2\.6/,
		set: { compat: { supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true } },
		why: "Kimi K2.6 on OpenRouter rejects the developer role and needs reasoning_content replay.",
	},
	{
		providers: ["openrouter"],
		match: /^inception\/mercury-2/,
		set: { thinkingLevelMap: { off: null } },
		why: "Mercury 2 disables tool calling when reasoning effort is none.",
	},

	// Fireworks
	{
		providers: ["fireworks"],
		match: /glm-5p2/,
		set: {
			api: "openai-completions",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			compat: { supportsStore: false, supportsDeveloperRole: false },
		},
		why: "Fireworks serves GLM 5.2 only on chat completions.",
	},

	// NVIDIA NIM: listed by NIM but fail on tool calls or system prompts when tested.
	{
		providers: ["nvidia"],
		match: new RegExp(
			`^(?:${[
				"abacusai/dracarys-llama-3.1-70b-instruct",
				"bytedance/seed-oss-36b-instruct",
				"deepseek-ai/deepseek-v4-flash",
				"deepseek-ai/deepseek-v4-pro",
				"google/gemma-2-2b-it",
				"google/gemma-3n-e2b-it",
				"google/gemma-3n-e4b-it",
				"google/gemma-4-31b-it",
				"meta/llama-3.2-1b-instruct",
				"meta/llama-4-maverick-17b-128e-instruct",
				"microsoft/phi-4-mini-instruct",
				"minimaxai/minimax-m2.7",
				"mistralai/mistral-nemotron",
				"nvidia/nemotron-mini-4b-instruct",
				"qwen/qwen3-next-80b-a3b-instruct",
				"qwen/qwen3.5-397b-a17b",
				"sarvamai/sarvam-m",
				"upstage/solar-10.7b-instruct",
			]
				.map((id) => id.replaceAll(".", "\\."))
				.join("|")})$`,
		),
		drop: true,
		why: "NIM lists these, but they failed lunR's tool-call and system-prompt checks.",
	},

	// Amazon Bedrock
	{
		providers: ["amazon-bedrock"],
		match: /^(?:ai21\.jamba|mistral\.mistral-7b-instruct-v0)/,
		drop: true,
		why: "Jamba cannot stream tool calls and Mistral 7B v0 rejects system messages on Bedrock.",
	},
];

function matches(rule: CatalogRule, model: Pick<Model<Api>, "id" | "provider" | "api">): boolean {
	if (rule.providers && !rule.providers.includes(model.provider)) return false;
	if (rule.notProviders?.includes(model.provider)) return false;
	if (rule.api && rule.api !== model.api) return false;
	return typeof rule.match === "string" ? rule.match === model.id : rule.match.test(model.id);
}

/** Apply every matching rule in order. Returns undefined when a rule drops the model. */
export function applyCatalogRules<T extends Model<Api>>(
	model: T,
	rules: readonly CatalogRule[] = CATALOG_RULES,
): T | undefined {
	let result = model;
	for (const rule of rules) {
		if (!matches(rule, result)) continue;
		if (rule.drop) return undefined;
		const { thinkingLevelMap, compat, cost, ...fields } = rule.set ?? {};
		result = {
			...result,
			...fields,
			...(thinkingLevelMap ? { thinkingLevelMap: { ...result.thinkingLevelMap, ...thinkingLevelMap } } : {}),
			...(compat ? { compat: { ...result.compat, ...compat } } : {}),
			...(cost ? { cost: { ...result.cost, ...cost } } : {}),
		};
	}
	return result;
}
