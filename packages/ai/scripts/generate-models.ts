#!/usr/bin/env node

/**
 * Builds lunR's model catalog from public sources.
 *
 * - models.dev supplies most providers and every model fact it carries (limits, prices,
 *   modalities, thinking levels). catalog-providers.ts says which providers ship and how to
 *   reach them.
 * - OpenRouter, Vercel AI Gateway and OpenAI's Codex list are read from their own APIs.
 * - src/catalog/rules.ts patches the few facts the sources get wrong.
 *
 * Every tool-capable models.dev row of a shipped provider becomes a model unless a rule drops
 * it with a reason, so a model a lab releases appears as soon as a source lists it.
 *
 * Usage: generate-models.ts [--strict] [--offline] [--json-output DIR] [--json-only]
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexCatalog } from "../src/catalog/codex.ts";
import { normalizeCatalogPricing } from "../src/catalog/metadata.ts";
import { MODELS_DEV_URL, type ModelsDevCatalog, ModelsDevFacts, modelFromModelsDev } from "../src/catalog/models-dev.ts";
import { applyCatalogRules } from "../src/catalog/rules.ts";
import type { Api, Model } from "../src/types.ts";
import { EXTRA_MODELS, LIVE_MODEL_LISTS, modelsDevModels, normalizeLiveId } from "./catalog-providers.ts";
import { CatalogSources } from "./catalog-sources.ts";
import { parseZenModelIds } from "./opencode-catalog.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_PUBLIC_CATALOG_URL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

function readOptions(args: string[]) {
	const options = { strict: false, offline: false, jsonOnly: false, jsonOutputDir: undefined as string | undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") options.strict = true;
		else if (arg === "--offline") options.offline = true;
		else if (arg === "--json-only") options.jsonOnly = true;
		else if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			options.jsonOutputDir = resolve(value);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.jsonOnly && !options.jsonOutputDir) throw new Error("--json-only requires --json-output");
	return options;
}

const options = readOptions(process.argv.slice(2));
const sources = new CatalogSources(join(packageRoot, "../../.artifacts/model-catalog-sources"), fetch, {
	offline: options.offline,
});

const hasData = (value: unknown) => Array.isArray((value as { data?: unknown })?.data) && (value as { data: unknown[] }).data.length > 0;

/** A source payload, or undefined when it is unavailable outside --strict. */
async function load<T>(url: string, validate: (value: unknown) => boolean = hasData): Promise<T | undefined> {
	try {
		return (await (await sources.fetch(url, validate)).json()) as T;
	} catch (error) {
		console.error(`Failed to load ${url}:`, error);
		if (options.strict) throw error;
		return undefined;
	}
}

async function loadLiveLists(): Promise<Map<string, Map<string, string> | undefined>> {
	const lists = new Map<string, Map<string, string> | undefined>();
	await Promise.all(
		Object.entries(LIVE_MODEL_LISTS).map(async ([key, url]) => {
			const payload = await load<unknown>(url);
			if (!payload) return lists.set(key, undefined);
			const ids = new Map<string, string>();
			for (const id of parseZenModelIds(payload)) ids.set(normalizeLiveId(id), id);
			lists.set(key, ids);
		}),
	);
	return lists;
}

interface OpenRouterRow {
	id: string;
	name?: string;
	supported_parameters?: string[];
	architecture?: { modality?: string };
	pricing?: Record<string, string | undefined>;
	context_length?: number;
	top_provider?: { context_length?: number; max_completion_tokens?: number };
}

const perMillion = (value: string | number | undefined) => {
	const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
	return Number.isFinite(parsed) ? Number((parsed * 1_000_000).toFixed(6)) : 0;
};

/** OpenRouter's own list is authoritative for what it serves; models.dev adds thinking levels. */
function openRouterModels(payload: { data: OpenRouterRow[] }, facts: ModelsDevFacts): Model<Api>[] {
	return payload.data.flatMap((row): Model<Api>[] => {
		if (!row.supported_parameters?.includes("tools")) return [];
		const known = facts.find(row.id, "openrouter");
		const reasoning = row.supported_parameters.includes("reasoning");
		const model = modelFromModelsDev(row.id, { ...known, reasoning }, {
			provider: "openrouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		return [
			{
				...model,
				name: row.name || row.id,
				input: row.architecture?.modality?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: perMillion(row.pricing?.prompt),
					output: perMillion(row.pricing?.completion),
					cacheRead: perMillion(row.pricing?.input_cache_read),
					cacheWrite: perMillion(row.pricing?.input_cache_write),
				},
				contextWindow: row.top_provider?.context_length || row.context_length || 4096,
				maxTokens: row.top_provider?.max_completion_tokens || 4096,
			},
		];
	});
}

interface GatewayRow {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: Record<string, string | number | undefined>;
}

/** Vercel AI Gateway, reached through its Anthropic-compatible endpoint. models.dev adds thinking levels. */
function gatewayModels(payload: { data: GatewayRow[] }, facts: ModelsDevFacts): Model<Api>[] {
	return payload.data.flatMap((row): Model<Api>[] => {
		const tags = row.tags ?? [];
		if (!tags.includes("tool-use")) return [];
		const known = facts.find(row.id, "vercel");
		const model = modelFromModelsDev(row.id, { ...known, reasoning: tags.includes("reasoning") }, {
			provider: "vercel-ai-gateway",
			api: "anthropic-messages",
			baseUrl: "https://ai-gateway.vercel.sh",
		});
		return [
			{
				...model,
				name: row.name || row.id,
				input: tags.includes("vision") ? ["text", "image"] : ["text"],
				cost: {
					input: perMillion(row.pricing?.input),
					output: perMillion(row.pricing?.output),
					cacheRead: perMillion(row.pricing?.input_cache_read),
					cacheWrite: perMillion(row.pricing?.input_cache_write),
				},
				contextWindow: row.context_window || 4096,
				maxTokens: row.max_tokens || 4096,
			},
		];
	});
}

/** Public Codex metadata is the offline seed; account availability is discovered at runtime. */
function codexModels(payload: unknown, models: readonly Model<Api>[]): Model<Api>[] {
	const codex = parseCodexCatalog(payload, "https://chatgpt.com/backend-api");
	for (const model of codex) {
		const metadata = models.find((candidate) => candidate.provider === "openai" && candidate.id === model.id);
		if (!metadata) continue;
		model.cost = metadata.cost;
		if (!model.catalog?.supplied.includes("maxTokens")) model.maxTokens = metadata.maxTokens;
		delete model.catalog?.pricing;
	}
	return codex;
}

async function generateModels() {
	const [modelsDev, openRouter, gateway, codex, liveLists] = await Promise.all([
		load<ModelsDevCatalog>(MODELS_DEV_URL, (value) =>
			["openai", "anthropic", "openrouter"].every(
				(id) => Object.keys((value as ModelsDevCatalog | undefined)?.[id]?.models ?? {}).length > 0,
			),
		),
		load<{ data: OpenRouterRow[] }>(OPENROUTER_MODELS_URL),
		load<{ data: GatewayRow[] }>(AI_GATEWAY_MODELS_URL),
		// The Codex seed has no fallback: without it the catalog would lose every Codex model.
		sources
			.fetch(CODEX_PUBLIC_CATALOG_URL, (value) => {
				try {
					return parseCodexCatalog(value, "https://chatgpt.com/backend-api").length > 0;
				} catch {
					return false;
				}
			})
			.then((response) => response.json()),
		loadLiveLists(),
	]);

	const data = modelsDev ?? {};
	const facts = new ModelsDevFacts(data);
	const allModels: Model<Api>[] = [
		...modelsDevModels(data, facts, liveLists),
		...(openRouter ? openRouterModels(openRouter, facts) : []),
		...(gateway ? gatewayModels(gateway, facts) : []),
		...EXTRA_MODELS.map((model) => structuredClone(model)),
	];
	allModels.push(...codexModels(codex, allModels));

	// Group by provider. The first row for an id wins, so models.dev beats extras.
	const providers: Record<string, Record<string, Model<Api>>> = {};
	for (const candidate of allModels) {
		const model = applyCatalogRules(candidate);
		if (!model) continue;
		providers[model.provider] ??= {};
		providers[model.provider][model.id] ??= normalizeCatalogPricing(model);
	}
	const providerIds = Object.keys(providers).sort();
	const sorted = Object.fromEntries(
		providerIds.map((provider) => [
			provider,
			Object.fromEntries(
				Object.keys(providers[provider])
					.sort()
					.map((id) => [id, providers[provider][id]]),
			),
		]),
	) as Record<string, Record<string, Model<Api>>>;

	if (!options.jsonOnly) writeTypeScript(sorted);
	if (options.jsonOutputDir) writeJson(options.jsonOutputDir, sorted);

	console.log("\nModel statistics:");
	console.log(`  Total: ${providerIds.reduce((sum, id) => sum + Object.keys(sorted[id]).length, 0)}`);
	for (const provider of providerIds) console.log(`  ${provider}: ${Object.keys(sorted[provider]).length}`);
}

/** Baked-in catalog for the ai package: one file per provider plus an aggregator. */
function writeTypeScript(providers: Record<string, Record<string, Model<Api>>>) {
	const header = "// This file is auto-generated by scripts/generate-models.ts\n// Do not edit manually - run 'npm run generate-models' to update\n\n";
	const constName = (provider: string) => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
	const emit = (model: Model<Api>) => {
		const lines = [`\t"${model.id}": {`, `\t\tid: "${model.id}",`, `\t\tname: ${JSON.stringify(model.name)},`];
		lines.push(`\t\tapi: "${model.api}",`, `\t\tprovider: "${model.provider}",`, `\t\tbaseUrl: "${model.baseUrl}",`);
		if (model.headers) lines.push(`\t\theaders: ${JSON.stringify(model.headers)},`);
		if (model.compat) lines.push(`\t\tcompat: ${JSON.stringify(model.compat)},`);
		if (model.catalog) lines.push(`\t\tcatalog: ${JSON.stringify(model.catalog)},`);
		lines.push(`\t\treasoning: ${model.reasoning},`);
		if (model.thinkingLevelMap) lines.push(`\t\tthinkingLevelMap: ${JSON.stringify(model.thinkingLevelMap)},`);
		lines.push(`\t\tinput: ${JSON.stringify(model.input)},`, `\t\tcost: ${JSON.stringify(model.cost)},`);
		lines.push(`\t\tcontextWindow: ${model.contextWindow},`, `\t\tmaxTokens: ${model.maxTokens},`);
		lines.push(`\t} satisfies Model<"${model.api}">,`);
		return lines.join("\n");
	};

	const providersDir = join(packageRoot, "src/providers");
	for (const entry of readdirSync(providersDir)) if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
	for (const [provider, models] of Object.entries(providers)) {
		const body = Object.values(models).map(emit).join("\n");
		writeFileSync(
			join(providersDir, `${provider}.models.ts`),
			`${header}import type { Model } from "../types.ts";\n\nexport const ${constName(provider)} = {\n${body}\n} as const;\n`,
		);
	}
	const ids = Object.keys(providers);
	const imports = ids.map((id) => `import { ${constName(id)} } from "./providers/${id}.models.ts";`).join("\n");
	const entries = ids.map((id) => `\t${JSON.stringify(id)}: ${constName(id)},`).join("\n");
	writeFileSync(join(packageRoot, "src/models.generated.ts"), `${header}${imports}\n\nexport const MODELS = {\n${entries}\n} as const;\n`);
	console.log(`Generated ${ids.length} catalogs under src/providers/`);
}

/** Publishable JSON: everything in models.json, one shard per provider, and source status. */
function writeJson(directory: string, providers: Record<string, Record<string, Model<Api>>>) {
	const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value)}\n`);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(join(directory, "providers"), { recursive: true });
	write(join(directory, "models.json"), providers);
	write(join(directory, "providers.json"), Object.keys(providers));
	write(join(directory, "sources.json"), sources.statuses.sort((a, b) => a.url.localeCompare(b.url)));
	for (const [provider, models] of Object.entries(providers)) write(join(directory, "providers", `${provider}.json`), models);
	console.log(`Generated JSON model catalog under ${directory}`);
}

generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
