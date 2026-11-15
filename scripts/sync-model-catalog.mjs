#!/usr/bin/env node

/**
 * Validate a generated model catalog and copy it to catalog/ for GitHub raw.
 * Does not upload to R2 — leave scripts/publish-model-catalog.mjs unused.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const REQUIRED_PROVIDERS = ["anthropic", "openai", "openai-codex", "openrouter"];
const MINIMUM_MODEL_COUNT = 500;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = join(REPO_ROOT, ".artifacts", "model-catalog");
const DEFAULT_OUTPUT = join(REPO_ROOT, "catalog");
const LEGACY_OFFICIAL_FILENAME = "official-models.json";

function parseArgs(args) {
	const options = {
		input: undefined,
		output: DEFAULT_OUTPUT,
		sourceCommit: undefined,
		check: false,
		versioned: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--versioned") { options.versioned = true; continue; }
		if (arg === "--check" || arg === "--check-only") {
			options.check = true;
			continue;
		}
		if (arg === "--input" || arg === "--output" || arg === "--source-commit") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			options[
				{
					"--input": "input",
					"--output": "output",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBundle(inputDir) {
	const modelsPath = join(inputDir, "models.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	const modelsBytes = readFileSync(modelsPath);
	const models = JSON.parse(modelsBytes.toString("utf8"));
	const providerIds = readJson(providerIndexPath);

	if (!isRecord(models)) throw new Error("models.json must contain an object");
	if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
		throw new Error("providers.json must contain an array of provider IDs");
	}

	const expectedProviderIds = Object.keys(models).sort();
	if (!isDeepStrictEqual(providerIds, expectedProviderIds)) {
		throw new Error("providers.json does not match the sorted providers in models.json");
	}
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!Object.hasOwn(models, providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}

	let modelCount = 0;
	for (const providerId of providerIds) {
		const providerModels = models[providerId];
		if (!isRecord(providerModels)) throw new Error(`Provider catalog must be an object: ${providerId}`);
		const providerFile = readJson(join(providersDir, `${providerId}.json`));
		if (!isDeepStrictEqual(providerFile, providerModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
		for (const [modelId, model] of Object.entries(providerModels)) {
			if (!isRecord(model) || model.id !== modelId || model.provider !== providerId) {
				throw new Error(`Invalid model entry: ${providerId}/${modelId}`);
			}
			if (typeof model.api !== "string" || !model.api || typeof model.baseUrl !== "string" ||
				!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 ||
				!Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
				!Array.isArray(model.input) || !model.input.length || !isRecord(model.cost) ||
				!["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(model.cost[key]) && model.cost[key] >= 0)) {
				throw new Error(`Invalid model capabilities: ${providerId}/${modelId}`);
			}
			modelCount++;
		}
	}

	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = providerIds.map((providerId) => `${providerId}.json`).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json");
	}
	if (modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}

	// Live discovery's facts index ships only with versioned publications, not in the CLI bundle.
	const factsPath = join(inputDir, "facts.json");
	let factsBytes;
	if (existsSync(factsPath)) {
		factsBytes = readFileSync(factsPath);
		const facts = JSON.parse(factsBytes.toString("utf8"));
		if (!isRecord(facts) || !Object.values(facts).every(isRecord)) {
			throw new Error("facts.json must map model ids to fact objects");
		}
	}

	const digest = createHash("sha256").update(modelsBytes).update(factsBytes ?? "").digest("hex");
	return {
		inputDir,
		factsPath: factsBytes ? factsPath : undefined,
		modelsPath,
		providerIndexPath,
		providersDir,
		providerIds,
		providerCount: providerIds.length,
		modelCount,
		revision: `sha256-${digest}`,
	};
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO_ROOT });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function resolveCheckInput(explicitInput, outputDir) {
	if (explicitInput) {
		if (!existsSync(join(explicitInput, "models.json"))) {
			throw new Error(`No models.json in --input ${explicitInput}`);
		}
		return explicitInput;
	}
	if (existsSync(join(DEFAULT_INPUT, "models.json"))) return DEFAULT_INPUT;
	if (existsSync(join(outputDir, "models.json"))) return outputDir;
	throw new Error("No catalog bundle found at .artifacts/model-catalog or catalog/");
}

/**
 * Providers the CLI bundle leaves out. Generic models.dev providers ship their rows only in versioned
 * publications, which keeps thousands of rows out of the package and the startup cache.
 */
function bundledProviderIds(bundle, versioned) {
	const genericPath = join(bundle.inputDir, "generic-providers.json");
	if (versioned || !existsSync(genericPath)) return bundle.providerIds;
	const generic = new Set(readJson(genericPath));
	return bundle.providerIds.filter((providerId) => !generic.has(providerId));
}

function syncBundle(bundle, outputDir, sourceCommit, versioned = false) {
	const publicationDir = outputDir;
	if (versioned) outputDir = join(outputDir, "snapshots", bundle.revision);
	mkdirSync(join(outputDir, "providers"), { recursive: true });
	const providerIds = bundledProviderIds(bundle, versioned);
	if (providerIds.length === bundle.providerIds.length) {
		copyFileSync(bundle.modelsPath, join(outputDir, "models.json"));
		copyFileSync(bundle.providerIndexPath, join(outputDir, "providers.json"));
	} else {
		const models = readJson(bundle.modelsPath);
		const shipped = Object.fromEntries(providerIds.map((providerId) => [providerId, models[providerId]]));
		writeFileSync(join(outputDir, "models.json"), `${JSON.stringify(shipped)}\n`);
		writeFileSync(join(outputDir, "providers.json"), `${JSON.stringify(providerIds)}\n`);
	}

	const destProviders = join(outputDir, "providers");
	const keep = new Set(providerIds.map((providerId) => `${providerId}.json`));
	for (const providerId of providerIds) {
		copyFileSync(join(bundle.providersDir, `${providerId}.json`), join(destProviders, `${providerId}.json`));
	}
	for (const name of readdirSync(destProviders)) {
		if (!name.endsWith(".json") || keep.has(name)) continue;
		rmSync(join(destProviders, name));
	}

	const leftover = join(outputDir, LEGACY_OFFICIAL_FILENAME);
	if (existsSync(leftover)) rmSync(leftover);
	const facts = versioned && bundle.factsPath ? readFileSync(bundle.factsPath) : undefined;
	if (facts) writeFileSync(join(outputDir, "facts.json"), facts);

	const publication = {
		version: 2,
		revision: bundle.revision,
		providers: providerIds,
		shards: Object.fromEntries(providerIds.map((id) => [id, createHash("sha256").update(JSON.stringify(readJson(join(bundle.providersDir, `${id}.json`)))).digest("hex")])),
		...(facts ? { facts: createHash("sha256").update(JSON.stringify(JSON.parse(facts.toString("utf8")))).digest("hex") } : {}),
		sources: existsSync(join(bundle.inputDir, "sources.json")) ? readJson(join(bundle.inputDir, "sources.json")) : [],
		generatedAt: new Date().toISOString(),
		sourceCommit,
		providerCount: providerIds.length,
		modelCount:
			providerIds.length === bundle.providerIds.length
				? bundle.modelCount
				: providerIds.reduce((sum, id) => sum + Object.keys(readJson(join(bundle.providersDir, `${id}.json`))).length, 0),
	};
	const publicationPath = join(publicationDir, "publication.json");
	// Data revisions are content-addressed; health timestamps remain in the manifest.
	writeFileSync(publicationPath, `${JSON.stringify(publication, null, 2)}\n`);
	return publication;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const outputDir = resolve(options.output);
	const inputDir = options.check
		? resolveCheckInput(options.input ? resolve(options.input) : undefined, outputDir)
		: resolve(options.input ?? DEFAULT_INPUT);

	if (!existsSync(join(inputDir, "models.json"))) {
		throw new Error(`No models.json in ${inputDir}`);
	}

	const bundle = validateBundle(inputDir);
	if (options.check) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					input: inputDir,
					providerCount: bundle.providerCount,
					modelCount: bundle.modelCount,
					revision: bundle.revision,
				},
				null,
				2,
			),
		);
		return;
	}

	const publication = syncBundle(bundle, outputDir, options.sourceCommit || gitSourceCommit(), options.versioned);
	console.log(JSON.stringify({ ...publication, output: outputDir, revision: bundle.revision }, null, 2));
}

main();
