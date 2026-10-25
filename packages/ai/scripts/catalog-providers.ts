/**
 * Which models.dev providers lunR ships, and how it talks to each one.
 * This file holds provider knowledge only (endpoint, transport, provider-wide request quirks).
 * Model facts come from models.dev; the few it gets wrong live in src/catalog/rules.ts.
 */
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/api/cloudflare.ts";
import {
	isAgentModel,
	type ModelsDevCatalog,
	type ModelsDevFacts,
	type ModelsDevModel,
	type ModelsDevTarget,
	modelFromModelsDev,
} from "../src/catalog/models-dev.ts";
import type { Api, KnownProvider, Model, OpenAICompletionsCompat } from "../src/types.ts";
import { shouldUseXaiResponsesApi, XAI_RESPONSES_COMPAT } from "../src/xai-effort.ts";
import { opencodeBaseUrl, resolveOpencodeApi } from "./opencode-catalog.ts";

/** Per-model transport. Returning undefined skips a row lunR cannot drive. */
export type ModelsDevRoute = (
	id: string,
	row: ModelsDevModel,
) => (Partial<Omit<ModelsDevTarget, "provider">> & { id?: string }) | undefined;

export interface ModelsDevSource extends Omit<ModelsDevTarget, "provider"> {
	provider: KnownProvider;
	/** models.dev provider keys. The first one present wins, since models.dev renames providers. */
	from: readonly string[];
	route?: ModelsDevRoute;
	/** Rows must also appear in this provider's own model list. */
	live?: keyof typeof LIVE_MODEL_LISTS;
	/**
	 * Also list live ids models.dev does not have yet. Only for lists of chat models: OpenCode's
	 * list is its coding catalog, while NIM's includes embedding and vision models.
	 */
	listLiveOnly?: boolean;
	/** Start with the context window of the base price tier, so requests do not silently cost more. */
	baseTierContext?: boolean;
	/** Leave out rows models.dev marks deprecated, for providers that retire them with no runtime filter. */
	skipDeprecated?: boolean;
	/** Subscription plans: prices do not apply. */
	free?: boolean;
	/** Drop long-context price tiers the provider does not bill. */
	flatPrice?: boolean;
	/** Estimated cache-read price as a share of input, for providers models.dev lists without one. */
	cacheReadShare?: number;
}

/** Live id lists that decide which models.dev rows a provider actually serves. */
export const LIVE_MODEL_LISTS = {
	nvidia: "https://integrate.api.nvidia.com/v1/models",
	opencode: "https://opencode.ai/zen/v1/models",
	"opencode-go": "https://opencode.ai/zen/go/v1/models",
} as const;

/** models.dev `npm` package to the lunR transport that speaks the same protocol. */
export function apiForNpm(npm: string | undefined): Api {
	if (npm === "@ai-sdk/openai") return "openai-responses";
	if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
	if (npm === "@ai-sdk/google") return "google-generative-ai";
	return "openai-completions";
}

const together: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

/** Effort-style models accept `reasoning_effort`; toggle-style ones only switch thinking on and off. */
function hasEffort(row: ModelsDevModel): boolean {
	return row.reasoning_options?.some((option) => option.type === "effort") === true;
}

function hasToggle(row: ModelsDevModel): boolean {
	return row.reasoning_options?.some((option) => option.type === "toggle") === true;
}

const qwen: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	thinkingFormat: "qwen",
	maxTokensField: "max_tokens",
};
const qwenRoute: ModelsDevRoute = (_id, row) => ({
	compat: { ...qwen, ...(hasEffort(row) ? { supportsReasoningEffort: true } : {}) },
});

const zaiRoute: ModelsDevRoute = (_id, row) => ({
	compat: {
		supportsDeveloperRole: false,
		thinkingFormat: "zai",
		zaiToolStream: true,
		...(hasEffort(row) ? { supportsReasoningEffort: true } : {}),
	},
});

const moonshot: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};

const xiaomi: OpenAICompletionsCompat = {
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

/** OpenCode routes each model by its SDK package; the Anthropic SDK appends /v1/messages itself. */
function opencodeRoute(basePath: string): ModelsDevRoute {
	return (id, row) => {
		const api = resolveOpencodeApi({ npm: row.provider?.npm, modelId: id });
		const baseUrl = opencodeBaseUrl(basePath, api);
		const compat: Model<Api>["compat"] =
			api === "openai-responses"
				? { sessionAffinityFormat: "openai-nosession" }
				: api === "openai-completions"
					? {
							maxTokensField: "max_tokens",
							...(row.provider?.npm === "@ai-sdk/alibaba" ? { cacheControlFormat: "anthropic" } : {}),
						}
					: undefined;
		return { api, baseUrl, ...(compat ? { compat } : {}) };
	};
}

export const MODELS_DEV_SOURCES: readonly ModelsDevSource[] = [
	{
		provider: "amazon-bedrock",
		from: ["amazon-bedrock"],
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		route: (id) => (id.startsWith("eu.") ? { baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com" } : {}),
	},
	{ provider: "anthropic", from: ["anthropic"], api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	{
		provider: "google",
		from: ["google"],
		api: "google-generative-ai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	{
		provider: "google-vertex",
		from: ["google-vertex"],
		api: "google-vertex",
		baseUrl: "https://{location}-aiplatform.googleapis.com",
		// Vertex also lists Claude and other partner models; lunR's Vertex transport only speaks Gemini.
		route: (id) => (id.startsWith("gemini-") ? {} : undefined),
	},
	{
		provider: "openai",
		from: ["openai"],
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		baseTierContext: true,
	},
	{
		provider: "azure-openai-responses",
		from: ["openai"],
		// Azure Foundry deployments of OpenAI models; the user's resource supplies the endpoint.
		api: "azure-openai-responses",
		baseUrl: "",
		flatPrice: true,
	},
	{ provider: "groq", from: ["groq"], api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
	{ provider: "cerebras", from: ["cerebras"], api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
	{
		provider: "cloudflare-workers-ai",
		from: ["cloudflare-workers-ai"],
		api: "openai-completions",
		baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
		compat: { sendSessionAffinityHeaders: true },
	},
	{
		provider: "cloudflare-ai-gateway",
		from: ["cloudflare-ai-gateway"],
		api: "openai-completions",
		baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		// Ids are `upstream/model`. OpenAI and Anthropic go through their passthroughs with the native id.
		route: (id) => {
			const slash = id.indexOf("/");
			const upstream = id.slice(0, slash);
			const nativeId = id.slice(slash + 1);
			if (upstream === "openai") {
				return { id: nativeId, api: "openai-responses", baseUrl: CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL };
			}
			if (upstream === "anthropic") {
				return {
					id: nativeId,
					api: "anthropic-messages",
					baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
					compat: { sendSessionAffinityHeaders: true },
				};
			}
			if (upstream === "workers-ai") return { compat: { sendSessionAffinityHeaders: true } };
			return undefined;
		},
	},
	{
		provider: "xai",
		from: ["xai"],
		api: "openai-completions",
		baseUrl: "https://api.x.ai/v1",
		route: (id) =>
			shouldUseXaiResponsesApi(id) ? { api: "openai-responses", compat: { ...XAI_RESPONSES_COMPAT } } : {},
	},
	{
		provider: "zai",
		from: ["zai-coding-plan"],
		api: "openai-completions",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		route: zaiRoute,
	},
	{
		provider: "zai-coding-cn",
		from: ["zai-coding-plan"],
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		route: zaiRoute,
	},
	{
		provider: "mistral",
		from: ["mistral"],
		api: "mistral-conversations",
		baseUrl: "https://api.mistral.ai",
		cacheReadShare: 0.1,
	},
	{
		provider: "huggingface",
		from: ["huggingface"],
		api: "openai-completions",
		baseUrl: "https://router.huggingface.co/v1",
		compat: { supportsDeveloperRole: false },
	},
	{
		provider: "fireworks",
		from: ["fireworks-ai"],
		// Fireworks' Anthropic-compatible API. It caches by prefix plus session affinity and rejects
		// cache_control on tools and eager input streaming. https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
		api: "anthropic-messages",
		baseUrl: "https://api.fireworks.ai/inference",
		compat: {
			sendSessionAffinityHeaders: true,
			supportsEagerToolInputStreaming: false,
			supportsCacheControlOnTools: false,
			supportsLongCacheRetention: false,
		},
	},
	{
		provider: "nvidia",
		from: ["nvidia"],
		api: "openai-completions",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		headers: { "NVCF-POLL-SECONDS": "3600" },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		},
		live: "nvidia",
		route: (_id, row) => (row.modalities?.input?.includes("text") === false ? undefined : {}),
	},
	{
		provider: "together",
		from: ["together", "togetherai", "together-ai"],
		api: "openai-completions",
		baseUrl: "https://api.together.ai/v1",
		skipDeprecated: true,
		// Toggle models take `reasoning: { enabled }`, effort models take `reasoning_effort`, and models
		// that always reason take neither.
		route: (_id, row) => {
			if (row.reasoning !== true) return { compat: together };
			const effort = hasEffort(row);
			return {
				compat: {
					...together,
					thinkingFormat: hasToggle(row) ? "together" : "openai",
					...(effort ? { supportsReasoningEffort: true } : {}),
				},
			};
		},
	},
	{
		provider: "opencode",
		from: ["opencode"],
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/v1",
		live: "opencode",
		listLiveOnly: true,
		route: opencodeRoute("https://opencode.ai/zen"),
	},
	{
		provider: "opencode-go",
		from: ["opencode-go"],
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/go/v1",
		live: "opencode-go",
		listLiveOnly: true,
		route: opencodeRoute("https://opencode.ai/zen/go"),
	},
	{
		provider: "github-copilot",
		from: ["github-copilot"],
		api: "openai-completions",
		baseUrl: "https://api.individual.githubcopilot.com",
		headers: COPILOT_HEADERS,
		// Copilot token users see every catalog row, not just the account picker, so retired rows stay out.
		skipDeprecated: true,
		// Copilot serves Claude on Messages and GPT on Responses; everything else is chat completions.
		route: (_id, row) => {
			const api = apiForNpm(row.provider?.npm);
			return api === "anthropic-messages" || api === "openai-responses"
				? { api }
				: { compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false } };
		},
	},
	// MiniMax's Anthropic-compatible API; the SDK appends /v1/messages.
	{ provider: "minimax", from: ["minimax"], api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
	{
		provider: "minimax-cn",
		from: ["minimax-cn"],
		api: "anthropic-messages",
		baseUrl: "https://api.minimaxi.com/anthropic",
	},
	{
		provider: "kimi-coding",
		// models.dev renamed `kimi-for-coding` and moved it to api.kimi.ai; lunR keeps its endpoint.
		from: ["kimi-for-coding", "kimi-code-plan-global"],
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding",
		headers: { "User-Agent": "KimiCLI/1.5" },
		compat: { forceAdaptiveThinking: true },
	},
	{
		provider: "moonshotai",
		from: ["moonshotai"],
		api: "openai-completions",
		baseUrl: "https://api.moonshot.ai/v1",
		compat: moonshot,
	},
	{
		provider: "moonshotai-cn",
		from: ["moonshotai-cn"],
		api: "openai-completions",
		baseUrl: "https://api.moonshot.cn/v1",
		compat: moonshot,
	},
	{
		provider: "xiaomi",
		from: ["xiaomi"],
		api: "openai-completions",
		baseUrl: "https://api.xiaomimimo.com/v1",
		compat: xiaomi,
	},
	...(["cn", "ams", "sgp"] as const).map(
		(region): ModelsDevSource => ({
			provider: `xiaomi-token-plan-${region}`,
			from: [`xiaomi-token-plan-${region}`],
			api: "openai-completions",
			baseUrl: `https://token-plan-${region}.xiaomimimo.com/v1`,
			compat: xiaomi,
		}),
	),
	{
		provider: "qwen-token-plan",
		from: ["alibaba-token-plan"],
		api: "openai-completions",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		route: qwenRoute,
		free: true,
	},
	{
		provider: "qwen-token-plan-cn",
		from: ["alibaba-token-plan-cn"],
		api: "openai-completions",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		route: qwenRoute,
		free: true,
	},
	{
		provider: "qwen-cloud",
		from: ["alibaba"],
		api: "openai-completions",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		route: qwenRoute,
	},
	{
		provider: "qwen-cloud-cn",
		from: ["alibaba-cn"],
		api: "openai-completions",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		route: qwenRoute,
	},
	{ provider: "deepseek", from: ["deepseek"], api: "openai-completions", baseUrl: "https://api.deepseek.com" },
];

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

/** NIM and OpenCode ids can differ from models.dev in case and `_` versus `.`. */
export const normalizeLiveId = (id: string) => id.toLowerCase().replaceAll("_", ".");

/** One models.dev row through its provider's route. Undefined when the route skips it. */
function sourceModel(source: ModelsDevSource, id: string, row: ModelsDevModel): Model<Api> | undefined {
	const route = source.route ? source.route(id, row) : {};
	if (!route) return undefined;
	const model = modelFromModelsDev(route.id ?? id, row, {
		provider: source.provider,
		api: route.api ?? source.api,
		baseUrl: route.baseUrl ?? source.baseUrl,
		headers: route.headers ?? source.headers,
		compat: { ...source.compat, ...route.compat } as Model<Api>["compat"],
	});
	if (source.free) model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	if (source.flatPrice) delete model.cost.tiers;
	if (source.cacheReadShare && row.cost?.cache_read === undefined && model.cost.input) {
		model.cost.cacheRead = Number((model.cost.input * source.cacheReadShare).toFixed(6));
	}
	const baseTier = model.cost.tiers?.[0]?.inputTokensAbove;
	if (source.baseTierContext && baseTier && baseTier < model.contextWindow) model.contextWindow = baseTier;
	if (!Object.keys(model.compat ?? {}).length) delete model.compat;
	return model;
}

function sourceModels(
	source: ModelsDevSource,
	data: ModelsDevCatalog,
	facts: ModelsDevFacts,
	live: Map<string, string> | undefined,
): Model<Api>[] {
	const key = source.from.find((candidate) => data[candidate]?.models);
	if (!key) {
		console.warn(`models.dev has no ${source.from.join(" or ")} provider for ${source.provider}`);
		return [];
	}
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	for (const [rowId, row] of Object.entries(data[key].models)) {
		if (!isAgentModel(row) || (source.skipDeprecated && row.status === "deprecated")) continue;
		let id = rowId;
		if (source.live) {
			// Without a live list, fall back to the rows models.dev still considers current.
			const liveId = live ? live.get(normalizeLiveId(rowId)) : row.status === "deprecated" ? undefined : rowId;
			if (!liveId) continue;
			id = liveId;
		}
		seen.add(id);
		const model = sourceModel(source, id, facts.complete(row));
		if (model) models.push(model);
	}
	// A provider can serve a model before models.dev lists it there. Borrow the closest known
	// model's facts, or conservative defaults when there is none.
	for (const id of source.listLiveOnly ? (live?.values() ?? []) : []) {
		if (seen.has(id)) continue;
		const known = facts.find(id, key);
		console.log(`${source.provider}: ${id} is live but not on models.dev${known ? "; using a related model's facts" : ""}`);
		// Prices belong to the host, so a borrowed row keeps its capabilities but not its price.
		const row: ModelsDevModel = {
			...known,
			name: id,
			reasoning: known?.reasoning ?? true,
			cost: undefined,
			// The borrowed row's SDK routing belongs to its host; the id decides here.
			provider: undefined,
			limit: { context: known?.limit?.context ?? 128000, output: known?.limit?.output ?? 8192 },
		};
		const model = sourceModel(source, id, row);
		if (model) models.push(model);
	}
	return models;
}

/**
 * Every shipped provider's models from models.dev. A tool-capable row becomes a model unless its
 * route or a live list says the provider cannot serve it; rules apply later.
 */
export function modelsDevModels(
	data: ModelsDevCatalog,
	facts: ModelsDevFacts,
	liveLists: ReadonlyMap<string, Map<string, string> | undefined> = new Map(),
): Model<Api>[] {
	return MODELS_DEV_SOURCES.flatMap((source) =>
		sourceModels(source, data, facts, source.live ? liveLists.get(source.live) : undefined),
	);
}
