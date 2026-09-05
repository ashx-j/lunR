import { type Api, type Credential, isOpenAiChatModel, type Model, parseOpenAiGptVersion } from "@earendil-works/pi-ai";
import { codexModelsUrl, resolveCodexCatalogVersion } from "@earendil-works/pi-ai/catalog/codex";
import { normalizeCatalogPricing } from "@earendil-works/pi-ai/catalog/metadata";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { discoverCodexModels } from "./codex-catalog.ts";
import { modelKey } from "./official-catalog.ts";

export const LIVE_CATALOG_TIMEOUT_MS = 4000;
export const INCOMPLETE_PROMPT_CAP = 8;
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 8192;

export const LIVE_LIST_PROVIDER_IDS = [
	"openai-codex",
	"xai",
	"openrouter",
	"qwen-cloud",
	"qwen-cloud-cn",
	"groq",
	"openai",
	"deepseek",
] as const;

export type LiveListProviderId = (typeof LIVE_LIST_PROVIDER_IDS)[number];

const LIVE_LIST_PROVIDER_SET = new Set<string>(LIVE_LIST_PROVIDER_IDS);

export function isLiveListProvider(providerId: string): providerId is LiveListProviderId {
	return LIVE_LIST_PROVIDER_SET.has(providerId);
}

export interface LiveFieldSupply {
	contextWindow: boolean;
	maxTokens: boolean;
	input: boolean;
	name: boolean;
	cost: boolean;
	reasoning: boolean;
}

export interface LiveModelDiscovery {
	model: Model<Api>;
	supplied: LiveFieldSupply;
}

export interface IncompleteLiveModel {
	provider: string;
	id: string;
	name: string;
	missing: Array<"contextWindow" | "maxTokens" | "input">;
	draft: Model<Api>;
	availableApis: Api[];
}

export type LiveCatalogStatus = "ok" | "timeout" | "error" | "skipped";

export interface LiveCatalogResult {
	discoveryClientVersion?: string;
	providerId: string;
	status: LiveCatalogStatus;
	discoveries: LiveModelDiscovery[];
	added: number;
	total: number;
	incomplete: IncompleteLiveModel[];
	error?: string;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const NONE_SUPPLIED: LiveFieldSupply = {
	contextWindow: false,
	maxTokens: false,
	input: false,
	name: false,
	cost: false,
	reasoning: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

export function modelsListUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/models`;
}

export function credentialAuthHeaders(credential: Credential | undefined): Record<string, string> {
	if (!credential) return {};
	if (credential.type === "api_key" && credential.key) {
		return { Authorization: `Bearer ${credential.key}` };
	}
	if (credential.type === "oauth" && typeof credential.access === "string" && credential.access) {
		return { Authorization: `Bearer ${credential.access}` };
	}
	return {};
}

/** OpenAI `{ data: [{ id, ... }] }` plus a bare array. */
export function parseOpenAIModelsList(value: unknown): Record<string, unknown>[] {
	const entries = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : [];
	const rows: Record<string, unknown>[] = [];
	for (const entry of entries) {
		if (typeof entry === "string" && entry.trim()) {
			rows.push({ id: entry.trim() });
			continue;
		}
		if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) rows.push(entry);
	}
	return rows;
}

export function firstBakedInModel(models: readonly Model<Api>[]): Model<Api> | undefined {
	return models[0];
}

export function selectLiveTemplate(
	providerId: string,
	id: string,
	bakedIn: readonly Model<Api>[],
): Model<Api> | undefined {
	const exact = bakedIn.find((model) => model.id === id);
	if (exact) return exact;
	const version = parseOpenAiGptVersion(id);
	if (providerId !== "openai" || !version || version.major < 5 || isOpenAiChatModel(id)) {
		return firstBakedInModel(bakedIn);
	}
	let reasoning: Model<Api> | undefined;
	for (const model of bakedIn) {
		if (model.reasoning && parseOpenAiGptVersion(model.id)) reasoning = model;
	}
	return reasoning ?? firstBakedInModel(bakedIn);
}

export function uniqueApis(models: readonly Model<Api>[]): Api[] {
	const seen = new Set<Api>();
	const apis: Api[] = [];
	for (const model of models) {
		if (seen.has(model.api)) continue;
		seen.add(model.api);
		apis.push(model.api);
	}
	return apis;
}

export function synthesizeLiveModel(
	id: string,
	template: Model<Api>,
	raw: Record<string, unknown> = {},
): LiveModelDiscovery {
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
	const exact = id === template.id;
	const discovery: LiveModelDiscovery = {
		model: {
			id,
			name,
			api: template.api,
			provider: template.provider,
			baseUrl: template.baseUrl,
			reasoning: template.reasoning,
			input: exact ? template.input : ["text"],
			cost: ZERO_COST,
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			compat: template.compat,
			thinkingLevelMap: exact ? template.thinkingLevelMap : undefined,
			catalog: { source: "provider", supplied: typeof raw.name === "string" ? ["name"] : [], pricing: "unknown" },
		},
		supplied: {
			...NONE_SUPPLIED,
			name: typeof raw.name === "string" && raw.name.trim().length > 0,
		},
	};
	const context = asFiniteNumber(raw.context_window ?? raw.context_length ?? raw.max_context_length);
	const output = asFiniteNumber(raw.max_output_tokens ?? raw.max_completion_tokens);
	if (context && context > 0) {
		discovery.model.contextWindow = context;
		discovery.supplied.contextWindow = true;
	}
	if (output && output > 0) {
		discovery.model.maxTokens = output;
		discovery.supplied.maxTokens = true;
	}
	if (typeof raw.reasoning === "boolean") {
		discovery.model.reasoning = raw.reasoning;
		discovery.supplied.reasoning = true;
	}
	if (Array.isArray(raw.input_modalities)) {
		const input = raw.input_modalities.filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (input.length) {
			discovery.model.input = input;
			discovery.supplied.input = true;
		}
	}
	discovery.model.catalog!.supplied = Object.entries(discovery.supplied)
		.filter(([, value]) => value)
		.map(([field]) => field) as NonNullable<Model<Api>["catalog"]>["supplied"];
	return discovery;
}

/** OpenRouter field mapping (tools filter, pricing × 1e6, context) from generate-models. */
export function mapOpenRouterModel(raw: Record<string, unknown>, template: Model<Api>): LiveModelDiscovery | undefined {
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return undefined;
	const supported = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
	if (!supported.includes("tools")) return undefined;

	const architecture = isRecord(raw.architecture) ? raw.architecture : undefined;
	const modality = typeof architecture?.modality === "string" ? architecture.modality : "";
	const input: ("text" | "image")[] = ["text"];
	if (modality.includes("image")) input.push("image");

	const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
	const inputCost = roundCost((asFiniteNumber(pricing?.prompt) ?? 0) * 1_000_000);
	const outputCost = roundCost((asFiniteNumber(pricing?.completion) ?? 0) * 1_000_000);
	const cacheReadCost = roundCost((asFiniteNumber(pricing?.input_cache_read) ?? 0) * 1_000_000);
	const cacheWriteCost = roundCost((asFiniteNumber(pricing?.input_cache_write) ?? 0) * 1_000_000);

	const topProvider = isRecord(raw.top_provider) ? raw.top_provider : undefined;
	const contextWindow = asFiniteNumber(topProvider?.context_length) ?? asFiniteNumber(raw.context_length);
	const maxTokens = asFiniteNumber(topProvider?.max_completion_tokens) ?? asFiniteNumber(raw.max_completion_tokens);

	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
	return {
		model: {
			id,
			name,
			api: template.api,
			provider: template.provider,
			baseUrl: template.baseUrl,
			reasoning: supported.includes("reasoning") || template.reasoning,
			input,
			cost: {
				input: inputCost,
				output: outputCost,
				cacheRead: cacheReadCost,
				cacheWrite: cacheWriteCost,
			},
			contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
			compat: template.compat,
			thinkingLevelMap: template.thinkingLevelMap,
		},
		supplied: {
			contextWindow: contextWindow !== undefined,
			maxTokens: maxTokens !== undefined,
			input: true,
			name: typeof raw.name === "string" && raw.name.trim().length > 0,
			cost: asFiniteNumber(pricing?.prompt) !== undefined && asFiniteNumber(pricing?.completion) !== undefined,
			reasoning: supported.includes("reasoning"),
		},
	};
}

export function discoverLiveModels(
	providerId: string,
	payload: unknown,
	bakedIn: readonly Model<Api>[],
): LiveModelDiscovery[] {
	if (providerId === "openai-codex")
		return discoverCodexModels(payload, bakedIn[0]?.baseUrl ?? "https://chatgpt.com/backend-api");
	const fallback = firstBakedInModel(bakedIn);
	if (!fallback) return [];
	const rows = parseOpenAIModelsList(payload);
	const discoveries: LiveModelDiscovery[] = [];
	for (const raw of rows) {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) continue;
		if (
			raw.tool_call === false ||
			raw.type === "embedding" ||
			(providerId === "openai" &&
				/^(?:text-embedding-|tts-|whisper-|dall-e-|gpt-image-|gpt-audio|gpt-realtime|sora-|.*moderation)/i.test(id))
		)
			continue;
		const template = { ...(selectLiveTemplate(providerId, id, bakedIn) ?? fallback), provider: providerId };
		if (providerId === "openrouter") {
			const mapped = mapOpenRouterModel(raw, template);
			if (mapped) {
				mapped.model.catalog = {
					source: "provider",
					...(!mapped.supplied.cost ? { pricing: "unknown" as const } : {}),
					supplied: Object.entries(mapped.supplied)
						.filter(([, supplied]) => supplied)
						.map(([key]) => key) as NonNullable<Model<Api>["catalog"]>["supplied"],
				};
				mapped.model = normalizeCatalogPricing(mapped.model);
				if (mapped.model.catalog?.pricing === "unknown") mapped.supplied.cost = false;
				discoveries.push(mapped);
			}
			continue;
		}
		discoveries.push(synthesizeLiveModel(id, template, raw));
	}
	return discoveries;
}

export function missingLiveFields(supplied: LiveFieldSupply): Array<"contextWindow" | "maxTokens" | "input"> {
	const missing: Array<"contextWindow" | "maxTokens" | "input"> = [];
	if (!supplied.contextWindow) missing.push("contextWindow");
	if (!supplied.maxTokens) missing.push("maxTokens");
	if (!supplied.input) missing.push("input");
	return missing;
}

export function isLiveModelIncomplete(discovery: LiveModelDiscovery, knownKeys: Set<string>): boolean {
	if (knownKeys.has(modelKey(discovery.model.provider, discovery.model.id))) return false;
	return missingLiveFields(discovery.supplied).length > 0;
}

export function collectIncompleteLiveModels(
	discoveries: readonly LiveModelDiscovery[],
	bakedIn: readonly Model<Api>[],
	knownKeys: Set<string>,
): IncompleteLiveModel[] {
	const apis = uniqueApis(bakedIn);
	const incomplete: IncompleteLiveModel[] = [];
	for (const discovery of discoveries) {
		if (!isLiveModelIncomplete(discovery, knownKeys)) continue;
		incomplete.push({
			provider: discovery.model.provider,
			id: discovery.model.id,
			name: discovery.model.name,
			missing: missingLiveFields(discovery.supplied),
			draft: discovery.model,
			availableApis: apis,
		});
	}
	return incomplete;
}

export function buildLiveOverlay(
	bakedIn: readonly Model<Api>[],
	discoveries: readonly LiveModelDiscovery[],
): Model<Api>[] {
	const bakedById = new Map(bakedIn.map((model) => [model.id, model]));
	const overlay: Model<Api>[] = [];
	for (const discovery of discoveries) {
		const baked = bakedById.get(discovery.model.id);
		if (!baked) {
			overlay.push(discovery.model);
			continue;
		}
		overlay.push({
			...baked,
			catalog: discovery.model.catalog,
			thinkingLevelMap: discovery.model.catalog?.supplied.includes("thinkingLevelMap")
				? discovery.model.thinkingLevelMap
				: baked.thinkingLevelMap,
			name: discovery.supplied.name ? discovery.model.name : baked.name,
			contextWindow: discovery.supplied.contextWindow ? discovery.model.contextWindow : baked.contextWindow,
			maxTokens: discovery.supplied.maxTokens ? discovery.model.maxTokens : baked.maxTokens,
			input: discovery.supplied.input ? discovery.model.input : baked.input,
			cost: discovery.supplied.cost ? discovery.model.cost : baked.cost,
			reasoning: discovery.supplied.reasoning ? discovery.model.reasoning : baked.reasoning,
		});
	}
	return overlay;
}

export function describeIncomplete(model: IncompleteLiveModel): string {
	const labels: string[] = [];
	for (const field of model.missing) {
		if (field === "contextWindow") labels.push("context window");
		else if (field === "maxTokens") labels.push("max tokens");
		else labels.push("input types");
	}
	let missingText = "metadata";
	if (labels.length === 1) missingText = labels[0] ?? missingText;
	else if (labels.length === 2) missingText = `${labels[0]} and ${labels[1]}`;
	else if (labels.length > 2) missingText = `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
	return `New model ${model.provider}/${model.id} — missing ${missingText}.`;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value?.trim()) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}

export interface IncompleteModelAnswers {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	api?: Api;
}

export function applyIncompleteAnswers(draft: Model<Api>, answers: IncompleteModelAnswers): Model<Api> {
	return {
		...draft,
		contextWindow: answers.contextWindow ?? draft.contextWindow,
		maxTokens: answers.maxTokens ?? draft.maxTokens,
		input: answers.input ?? draft.input,
		reasoning: answers.reasoning ?? draft.reasoning,
		api: answers.api ?? draft.api,
	};
}

export interface FetchLiveProviderModelsOptions {
	discoveryClientVersion?: string;
	providerId: string;
	baseUrl: string;
	bakedIn: readonly Model<Api>[];
	credential?: Credential;
	knownKeys: Set<string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export async function fetchLiveProviderModels(options: FetchLiveProviderModelsOptions): Promise<LiveCatalogResult> {
	const empty: LiveCatalogResult = {
		providerId: options.providerId,
		status: "skipped",
		discoveries: [],
		added: 0,
		total: 0,
		incomplete: [],
	};
	const template = firstBakedInModel(options.bakedIn);
	if ((!template && options.providerId !== "openai-codex") || !options.baseUrl) return empty;

	const timeoutMs = options.timeoutMs ?? LIVE_CATALOG_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onParentAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onParentAbort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		const fetchImpl = options.fetchImpl ?? fetch;
		const codex = options.providerId === "openai-codex";
		const accountId =
			options.credential?.type === "oauth" && typeof options.credential.accountId === "string"
				? options.credential.accountId
				: undefined;
		let discoveryClientVersion = options.discoveryClientVersion;
		const payload = await Promise.race([
			(async () => {
				if (codex)
					discoveryClientVersion = await resolveCodexCatalogVersion(
						fetchImpl,
						controller.signal,
						discoveryClientVersion,
					);
				const response = await fetchImpl(
					codex ? codexModelsUrl(options.baseUrl, discoveryClientVersion) : modelsListUrl(options.baseUrl),
					{
						headers: {
							accept: "application/json",
							"User-Agent": getPiUserAgent(VERSION),
							...credentialAuthHeaders(options.credential),
							...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
						},
						signal: controller.signal,
					},
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json();
			})(),
			new Promise<never>((_, reject) => {
				const abortError = new Error("The operation was aborted");
				abortError.name = "AbortError";
				controller.signal.addEventListener("abort", () => reject(abortError), { once: true });
				if (controller.signal.aborted) reject(abortError);
			}),
		]);
		const discoveries = codex
			? discoverCodexModels(payload, options.baseUrl)
			: discoverLiveModels(options.providerId, payload, options.bakedIn);
		if (!discoveries.length) throw new Error("No usable models returned; retaining cached models");
		const bakedIds = new Set(options.bakedIn.map((model) => model.id));
		const added = discoveries.filter((discovery) => !bakedIds.has(discovery.model.id)).length;
		return {
			providerId: options.providerId,
			discoveryClientVersion,
			status: "ok",
			discoveries,
			added,
			total: discoveries.length,
			incomplete: collectIncompleteLiveModels(discoveries, options.bakedIn, options.knownKeys),
		};
	} catch (error) {
		if (options.signal?.aborted && !timedOut) return { ...empty, status: "skipped", error: "aborted" };
		if (timedOut || (error instanceof Error && error.name === "AbortError")) {
			return { ...empty, status: "timeout", error: "timed out" };
		}
		return {
			...empty,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onParentAbort);
	}
}
