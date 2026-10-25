import type { AnthropicMessagesCompat, Api, Model, ModelCost, ModelCostTier, ThinkingLevelMap } from "../types.ts";

/**
 * Reader for https://models.dev/api.json, the public catalog lunR builds most provider rows from.
 * The generator and live discovery both turn models.dev facts into lunR models through these
 * functions, so a model's thinking levels, prices and limits come from data instead of id lists.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** One reasoning control a model accepts. */
export type ModelsDevReasoningOption =
	| { type: "effort"; values?: string[] }
	| { type: "toggle" }
	| { type: "budget_tokens"; min?: number; max?: number };

interface ModelsDevRates {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

/** A model row. Only the fields lunR reads are typed. */
export interface ModelsDevModel {
	id?: string;
	name?: string;
	/** Model line, such as `claude-opus` or `gpt-sol`. */
	family?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	/** False when the model rejects a custom temperature. */
	temperature?: boolean;
	status?: string | null;
	limit?: { context?: number; input?: number; output?: number };
	cost?: ModelsDevRates & { tiers?: (ModelsDevRates & { tier?: { type?: string; size?: number } })[] };
	modalities?: { input?: string[]; output?: string[] };
	/** Per-model transport for gateways that serve several protocols. */
	provider?: { npm?: string; api?: string };
	/** `lab/model` of the lab's own row, on rows hosted by someone else. */
	canonical_model_id?: string;
}

export interface ModelsDevProvider {
	id?: string;
	name?: string;
	npm?: string;
	api?: string;
	env?: string[];
	models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** Where and how lunR sends requests for a models.dev row. */
export interface ModelsDevTarget {
	provider: string;
	api: Api;
	baseUrl: string;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

/** A row lunR can drive as a coding agent: it calls tools and answers in text. */
export function isAgentModel(row: ModelsDevModel): boolean {
	if (row.tool_call !== true) return false;
	const output = row.modalities?.output;
	return !output || output.includes("text");
}

export function modelsDevInput(row: ModelsDevModel): ("text" | "image")[] {
	return row.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
}

/** Per-million prices, including request-wide long-context tiers. Missing prices read as 0. */
export function modelsDevCost(row: ModelsDevModel): ModelCost {
	const base = row.cost ?? {};
	const cost: ModelCost = {
		input: base.input ?? 0,
		output: base.output ?? 0,
		cacheRead: base.cache_read ?? 0,
		cacheWrite: base.cache_write ?? 0,
	};
	const tiers: ModelCostTier[] = [];
	for (const tier of base.tiers ?? []) {
		if (tier.tier?.type !== "context" || !tier.tier.size) continue;
		tiers.push({
			inputTokensAbove: tier.tier.size,
			input: tier.input ?? cost.input,
			output: tier.output ?? cost.output,
			cacheRead: tier.cache_read ?? cost.cacheRead,
			cacheWrite: tier.cache_write ?? cost.cacheWrite,
		});
	}
	if (tiers.length) cost.tiers = tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return cost;
}

const EFFORT_LEVELS = ["minimal", "low", "medium", "high"] as const;
const KNOWN_EFFORTS = new Set<string>([...EFFORT_LEVELS, "xhigh", "max"]);

/**
 * Thinking levels from `reasoning_options`. A level the model does not accept maps to null so the
 * picker hides it; xhigh and max only appear when listed. Missing options leave transport defaults.
 */
export function modelsDevThinkingLevelMap(row: ModelsDevModel, api: Api): ThinkingLevelMap | undefined {
	const options = row.reasoning_options;
	if (row.reasoning !== true || !options) return undefined;
	const effort = options.find((option) => option.type === "effort")?.values;
	const toggle = options.some((option) => option.type === "toggle");
	const budget = options.some((option) => option.type === "budget_tokens");
	const map: ThinkingLevelMap = {};

	if (effort) {
		for (const level of EFFORT_LEVELS) if (!effort.includes(level)) map[level] = null;
		// Some hosts name a single "on" effort (Groq's Qwen takes "default"); it becomes high.
		const custom = effort.find((value) => value !== "none" && !KNOWN_EFFORTS.has(value));
		if (custom && !EFFORT_LEVELS.some((level) => effort.includes(level))) map.high = custom;
		if (effort.includes("xhigh")) map.xhigh = "xhigh";
		if (effort.includes("max")) map.max = "max";
		// Effort "none" turns thinking off. Anthropic turns it off by omitting the thinking block, which
		// models.dev does not list as a toggle; models that reject that need a catalog rule.
		if (effort.includes("none")) map.off = "none";
		else if (!toggle && api !== "anthropic-messages") map.off = null;
	} else if (toggle && !budget) {
		// On/off only: "high" means on.
		Object.assign(map, { minimal: null, low: null, medium: null });
	} else if (!toggle && !budget) {
		// Always reasons and takes no controls.
		Object.assign(map, { off: null, minimal: null, low: null, medium: null });
	}
	return Object.keys(map).length ? map : undefined;
}

/**
 * Claude request settings. Anthropic offers effort "max" on every adaptive-thinking Claude model and
 * on no budget-only one (Opus 4.5 takes effort low to high with budget thinking). Other models on
 * Anthropic-compatible hosts keep budget thinking unless their provider says otherwise.
 */
function anthropicCompat(row: ModelsDevModel): AnthropicMessagesCompat {
	const effort = row.reasoning_options?.find((option) => option.type === "effort")?.values;
	const adaptive = row.reasoning === true && row.family?.startsWith("claude") === true && effort?.includes("max");
	return {
		...(adaptive ? { forceAdaptiveThinking: true } : {}),
		...(row.temperature === false ? { supportsTemperature: false } : {}),
	};
}

/** A lunR model from a models.dev row. Missing limits fall back to 4096 like the rest of the catalog. */
export function modelFromModelsDev(id: string, row: ModelsDevModel, target: ModelsDevTarget): Model<Api> {
	const anthropic = target.api === "anthropic-messages";
	const compat: Record<string, unknown> = { ...(anthropic ? anthropicCompat(row) : {}), ...target.compat };
	// Anthropic budget thinking maps every level to a token budget, so effort lists only apply to adaptive models.
	const thinkingLevelMap =
		anthropic && compat.forceAdaptiveThinking !== true ? undefined : modelsDevThinkingLevelMap(row, target.api);
	return {
		id,
		name: row.name || id,
		api: target.api,
		provider: target.provider,
		baseUrl: target.baseUrl,
		...(target.headers ? { headers: { ...target.headers } } : {}),
		...(Object.keys(compat).length ? { compat: compat as Model<Api>["compat"] } : {}),
		reasoning: row.reasoning === true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: modelsDevInput(row),
		cost: modelsDevCost(row),
		contextWindow: row.limit?.context || 4096,
		maxTokens: row.limit?.output || 4096,
	};
}

/** Strips gateway decorations, so `~anthropic/claude-x:batch` and `claude-x@2026` both read `claude-x`. */
export function bareModelId(id: string): string {
	return id
		.replace(/^~/, "")
		.replace(/^.*\//, "")
		.replace(/[:@].*$/, "")
		.toLowerCase();
}

/**
 * Model facts across all of models.dev. Hosts often list a model with fewer details than its lab,
 * so `complete` fills a row's missing capabilities from the lab's own row, and `find` locates
 * facts for an id a source lists without them: a gateway variant, or a model a provider serves
 * before models.dev has a row for it there.
 */
export class ModelsDevFacts {
	private readonly catalog: ModelsDevCatalog;
	private readonly index = new Map<string, { key: string; row: ModelsDevModel }[]>();

	constructor(catalog: ModelsDevCatalog) {
		this.catalog = catalog;
		for (const [key, provider] of Object.entries(catalog)) {
			for (const [id, row] of Object.entries(provider.models ?? {})) {
				const bare = bareModelId(id);
				const entries = this.index.get(bare) ?? [];
				entries.push({ key, row });
				this.index.set(bare, entries);
			}
		}
	}

	/**
	 * The host's own facts win, the lab's fill the gaps, and a temperature rejection from either
	 * holds because it belongs to the model rather than the host.
	 */
	complete(row: ModelsDevModel): ModelsDevModel {
		const slash = row.canonical_model_id?.indexOf("/") ?? -1;
		if (!row.canonical_model_id || slash < 0) return row;
		const lab =
			this.catalog[row.canonical_model_id.slice(0, slash)]?.models?.[row.canonical_model_id.slice(slash + 1)];
		if (!lab) return row;
		return {
			...row,
			family: row.family ?? lab.family,
			reasoning_options: row.reasoning_options ?? lab.reasoning_options,
			temperature:
				row.temperature === false || lab.temperature === false ? false : (row.temperature ?? lab.temperature),
			modalities: row.modalities ?? lab.modalities,
			limit: row.limit ?? lab.limit,
		};
	}

	/**
	 * Exact matches beat the longest known id the new one extends (`claude-opus-5-5-backup` reads
	 * `claude-opus-5-5`), and the preferred models.dev provider beats the rest.
	 */
	find(id: string, preferKey?: string): ModelsDevModel | undefined {
		const bare = bareModelId(id);
		let candidates = this.index.get(bare);
		if (!candidates) {
			let best = "";
			for (const known of this.index.keys()) {
				if (known.length > best.length && bare.startsWith(`${known}-`)) best = known;
			}
			candidates = best ? this.index.get(best) : undefined;
		}
		const found = (candidates?.find((candidate) => candidate.key === preferKey) ?? candidates?.[0])?.row;
		return found ? this.complete(found) : undefined;
	}
}
