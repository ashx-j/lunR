import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { codexModelsUrl, resolveCodexCatalogVersion } from "@earendil-works/pi-ai/catalog/codex";
import { normalizeCatalogPricing } from "@earendil-works/pi-ai/catalog/metadata";
import type { ModelsDevFacts, ModelsDevModel } from "@earendil-works/pi-ai/catalog/models-dev";
import { discoveredModel } from "@earendil-works/pi-ai/catalog/providers";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { discoverCodexModels } from "./codex-catalog.ts";
import { modelKey } from "./official-catalog.ts";

export const LIVE_CATALOG_TIMEOUT_MS = 4000;
export const INCOMPLETE_PROMPT_CAP = 8;
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 8192;

/** How lunR reads a provider's own model list. */
export type LiveListProtocol = "codex" | "openai" | "anthropic" | "google";

/**
 * Providers whose list lunR does not read: OpenCode's free rows follow its Zen list and models.dev,
 * Copilot's picker arrives with its login, and Radius has no fixed list endpoint.
 */
const UNLISTED_PROVIDERS = new Set(["opencode", "github-copilot", "radius"]);

/** The list protocol for a provider, from the transport its catalog uses. */
export function liveListProtocol(providerId: string, bakedIn: readonly Model<Api>[]): LiveListProtocol | undefined {
	if (providerId === "openai-codex") return "codex";
	if (UNLISTED_PROVIDERS.has(providerId)) return undefined;
	const api = bakedIn[0]?.api;
	if (api === "openai-completions" || api === "openai-responses") return "openai";
	// Other Anthropic-compatible hosts (MiniMax, Kimi) have no documented list endpoint.
	if (api === "anthropic-messages") return providerId === "anthropic" ? "anthropic" : undefined;
	if (api === "google-generative-ai") return "google";
	return undefined;
}

/** Ids of embedding, speech, image, video and safety models that lists mix in with chat models. */
const NON_CHAT_ID =
	/(?:^|[-/_.])(?:embed|embedding|whisper|tts|speech|transcribe|audio|realtime|image|imagen|dall-e|sora|veo|video|moderation|guard|rerank|ocr|aqa)(?:$|[-/_.\d])/i;

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

/** `skipped` covers a provider that does not offer a list (HTTP 4xx), so a refresh stays quiet about it. */
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

/** Transport settings for ids the catalog does not build: the same id if baked in, else the provider's first model. */
export function selectLiveTemplate(id: string, bakedIn: readonly Model<Api>[]): Model<Api> | undefined {
	return bakedIn.find((model) => model.id === id) ?? firstBakedInModel(bakedIn);
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

/** One model as the provider's own list describes it. */
export interface ListedModel {
	id: string;
	reported: ModelsDevModel;
	raw: Record<string, unknown>;
}

function positive(value: unknown): number | undefined {
	const number = asFiniteNumber(value);
	return number && number > 0 ? number : undefined;
}

function textAndImage(image: boolean): ("text" | "image")[] {
	return image ? ["text", "image"] : ["text"];
}

/** An OpenAI-style row's optional capability fields (xAI and others add some). */
function reportedOpenAIFields(raw: Record<string, unknown>): ModelsDevModel {
	const input = Array.isArray(raw.input_modalities)
		? raw.input_modalities.filter((value): value is string => value === "text" || value === "image")
		: [];
	return {
		name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
		reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
		limit: {
			context: positive(raw.context_window ?? raw.context_length ?? raw.max_context_length),
			output: positive(raw.max_output_tokens ?? raw.max_completion_tokens),
		},
		...(input.length ? { modalities: { input } } : {}),
	};
}

/**
 * Anthropic's list reports limits and capabilities, including the thinking types and effort
 * levels each model accepts.
 */
function reportedAnthropicFields(raw: Record<string, unknown>): ModelsDevModel {
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const supported = (value: unknown) => isRecord(value) && value.supported === true;
	const thinking = isRecord(capabilities.thinking) ? capabilities.thinking : {};
	const types = isRecord(thinking.types) ? thinking.types : {};
	const effort = isRecord(capabilities.effort) ? capabilities.effort : {};
	const levels = ["low", "medium", "high", "xhigh", "max"].filter((level) => supported(effort[level]));
	return {
		name: typeof raw.display_name === "string" ? raw.display_name : undefined,
		family: "claude",
		reasoning: supported(thinking),
		reasoning_options: [
			...(levels.length ? [{ type: "effort" as const, values: levels }] : []),
			...(supported(types.enabled) ? [{ type: "budget_tokens" as const }] : []),
		],
		limit: { context: positive(raw.max_input_tokens), output: positive(raw.max_tokens) },
		modalities: { input: textAndImage(supported(capabilities.image_input)) },
	};
}

/** The models a provider's list payload names, with what it reports about each. */
export function listedModels(protocol: Exclude<LiveListProtocol, "codex">, payload: unknown): ListedModel[] {
	if (protocol === "google") {
		const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
		return models.flatMap((raw): ListedModel[] => {
			if (!isRecord(raw) || typeof raw.name !== "string") return [];
			const methods = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
			if (!methods.includes("generateContent")) return [];
			return [
				{
					id: raw.name.replace(/^models\//, ""),
					raw,
					reported: {
						name: typeof raw.displayName === "string" ? raw.displayName : undefined,
						reasoning: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
						limit: { context: positive(raw.inputTokenLimit), output: positive(raw.outputTokenLimit) },
					},
				},
			];
		});
	}
	return parseOpenAIModelsList(payload).flatMap((raw): ListedModel[] => {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id || raw.tool_call === false || raw.type === "embedding") return [];
		if (protocol === "anthropic") return [{ id, raw, reported: reportedAnthropicFields(raw) }];
		return [{ id, raw, reported: reportedOpenAIFields(raw) }];
	});
}

/** Defaults for an id the catalog cannot build, taking only transport settings from a template. */
function templateModel(id: string, template: Model<Api>): Model<Api> {
	const exact = id === template.id;
	return {
		id,
		name: id,
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
	};
}

/** Lay what the provider reported over a model and record which fields it supplied. */
function withReported(model: Model<Api>, reported: ModelsDevModel): LiveModelDiscovery {
	const input = reported.modalities?.input;
	const supplied: LiveFieldSupply = {
		...NONE_SUPPLIED,
		name: !!reported.name,
		contextWindow: !!reported.limit?.context,
		maxTokens: !!reported.limit?.output,
		input: !!input?.length,
		reasoning: reported.reasoning !== undefined,
	};
	const discovered: Model<Api> = {
		...model,
		name: reported.name ?? model.name,
		contextWindow: reported.limit?.context ?? model.contextWindow,
		maxTokens: reported.limit?.output ?? model.maxTokens,
		input: input?.length ? textAndImage(input.includes("image")) : model.input,
		reasoning: reported.reasoning ?? model.reasoning,
		catalog: {
			source: "provider",
			supplied: Object.entries(supplied)
				.filter(([, value]) => value)
				.map(([field]) => field) as NonNullable<Model<Api>["catalog"]>["supplied"],
			pricing: "unknown",
		},
	};
	return { model: discovered, supplied };
}

/** A listed id on the template path, for callers that have no list payload. */
export function synthesizeLiveModel(
	id: string,
	template: Model<Api>,
	raw: Record<string, unknown> = {},
): LiveModelDiscovery {
	return withReported(templateModel(id, template), reportedOpenAIFields(raw));
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

export interface DiscoverLiveModelsOptions {
	protocol?: LiveListProtocol;
	/** provider/id keys the catalog already has; their rows only take provider-reported fields. */
	known?: ReadonlySet<string>;
	/** models.dev facts for ids the catalog does not have yet. */
	facts?: ModelsDevFacts;
}

/**
 * Models from a provider's list payload. Ids the catalog knows keep its row and take only the
 * fields the provider reported. New ids go through the same resolver the catalog generator uses,
 * so they get the settings the next publication will give them.
 */
export function discoverLiveModels(
	providerId: string,
	payload: unknown,
	bakedIn: readonly Model<Api>[],
	options: DiscoverLiveModelsOptions = {},
): LiveModelDiscovery[] {
	if (providerId === "openai-codex")
		return discoverCodexModels(payload, bakedIn[0]?.baseUrl ?? "https://chatgpt.com/backend-api");
	const fallback = firstBakedInModel(bakedIn);
	if (providerId === "openrouter")
		return fallback ? discoverOpenRouterModels(payload, { ...fallback, provider: providerId }) : [];
	const protocol = options.protocol ?? liveListProtocol(providerId, bakedIn) ?? "openai";
	if (protocol === "codex") return [];
	const bakedIds = new Set(bakedIn.map((model) => model.id));
	const discoveries: LiveModelDiscovery[] = [];
	for (const listed of listedModels(protocol, payload)) {
		const known = bakedIds.has(listed.id) || options.known?.has(modelKey(providerId, listed.id)) === true;
		// models.dev knows some new ids as models that cannot call tools.
		if (!known && (NON_CHAT_ID.test(listed.id) || options.facts?.find(listed.id)?.tool_call === false)) continue;
		const template = selectLiveTemplate(listed.id, bakedIn);
		// A known id with no template to copy resolves through models.dev too.
		const model =
			((!known || !template) && discoveredModel(providerId, listed.id, listed.reported, options.facts)) ||
			(template && templateModel(listed.id, { ...template, provider: providerId }));
		if (model) discoveries.push(withReported(model, listed.reported));
	}
	return discoveries;
}

function discoverOpenRouterModels(payload: unknown, template: Model<Api>): LiveModelDiscovery[] {
	const discoveries: LiveModelDiscovery[] = [];
	for (const raw of parseOpenAIModelsList(payload)) {
		const mapped = mapOpenRouterModel(raw, template);
		if (!mapped) continue;
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
	/** Loads models.dev facts; called only when the list names an id the catalog does not have. */
	getFacts?: () => Promise<ModelsDevFacts | undefined>;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

interface ListRequest {
	url: string;
	headers: Record<string, string>;
}

/** The list request for a provider, or undefined when its credential cannot read the list. */
function listRequest(
	protocol: LiveListProtocol,
	baseUrl: string,
	credential: Credential | undefined,
	clientVersion: string | undefined,
): ListRequest | undefined {
	const base = baseUrl.replace(/\/+$/u, "");
	const apiKey = credential?.type === "api_key" ? credential.key : undefined;
	if (protocol === "anthropic") {
		// API keys only: Claude subscriptions run through Claude Code, whose credentials lunR never reads.
		if (!apiKey) return undefined;
		return {
			url: `${base}/v1/models?limit=1000`,
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
		};
	}
	if (protocol === "google") {
		if (!apiKey) return undefined;
		return { url: `${base}/models?pageSize=1000`, headers: { "x-goog-api-key": apiKey } };
	}
	const accountId =
		credential?.type === "oauth" && typeof credential.accountId === "string" ? credential.accountId : undefined;
	const headers = { ...credentialAuthHeaders(credential), ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}) };
	if (protocol === "codex") return { url: codexModelsUrl(baseUrl, clientVersion), headers };
	return { url: modelsListUrl(baseUrl), headers };
}

class ListUnavailable extends Error {}

/** Error text for a list request the provider refused with 401 or 403; an automatic refresh does not retry it early. */
export const LIVE_LIST_REJECTED = "model list rejected the login";

/** Only listing protocols that read API keys; any other login skips the list quietly. */
export function listNeedsApiKey(protocol: LiveListProtocol | undefined): boolean {
	return protocol === "anthropic" || protocol === "google";
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
	const protocol = liveListProtocol(options.providerId, options.bakedIn);
	const codex = protocol === "codex";
	if (!protocol || !options.baseUrl) return empty;

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
		let discoveryClientVersion = options.discoveryClientVersion;
		const payload = await Promise.race([
			(async () => {
				if (codex)
					discoveryClientVersion = await resolveCodexCatalogVersion(
						fetchImpl,
						controller.signal,
						discoveryClientVersion,
					);
				const request = listRequest(protocol, options.baseUrl, options.credential, discoveryClientVersion);
				if (!request) throw new ListUnavailable("this login cannot read the model list");
				const response = await fetchImpl(request.url, {
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...request.headers,
					},
					signal: controller.signal,
				});
				// A provider without a list endpoint answers 400, 404 or 405; keep its catalog rows and stay quiet.
				if ([400, 404, 405, 501].includes(response.status) && !codex) {
					throw new ListUnavailable(`model list unavailable (HTTP ${response.status})`);
				}
				if (response.status === 401 || response.status === 403) {
					throw new Error(`${LIVE_LIST_REJECTED} (HTTP ${response.status})`);
				}
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
		const bakedIds = new Set(options.bakedIn.map((model) => model.id));
		const isKnown = (id: string) => bakedIds.has(id) || options.knownKeys.has(modelKey(options.providerId, id));
		// OpenRouter's own list carries everything it needs; elsewhere only new chat ids need facts.
		const unknown =
			options.providerId !== "openrouter" &&
			listedIds(protocol, payload).some((id) => !isKnown(id) && !NON_CHAT_ID.test(id));
		const facts = unknown ? await options.getFacts?.() : undefined;
		const discoveries = codex
			? discoverCodexModels(payload, options.baseUrl)
			: discoverLiveModels(options.providerId, payload, options.bakedIn, {
					protocol,
					known: options.knownKeys,
					facts,
				});
		if (!discoveries.length) throw new ListUnavailable("no usable models returned; retaining cached models");
		const added = discoveries.filter((discovery) => !isKnown(discovery.model.id)).length;
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
		if (error instanceof ListUnavailable) return { ...empty, status: "skipped", error: error.message };
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

function listedIds(protocol: LiveListProtocol, payload: unknown): string[] {
	return protocol === "codex" ? [] : listedModels(protocol, payload).map((model) => model.id);
}
