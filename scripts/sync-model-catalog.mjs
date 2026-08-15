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

const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
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
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
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

	const digest = createHash("sha256").update(modelsBytes).digest("hex");
	return {
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

function syncBundle(bundle, outputDir, sourceCommit) {
	mkdirSync(join(outputDir, "providers"), { recursive: true });
	copyFileSync(bundle.modelsPath, join(outputDir, "models.json"));
	copyFileSync(bundle.providerIndexPath, join(outputDir, "providers.json"));

	const destProviders = join(outputDir, "providers");
	const keep = new Set(bundle.providerIds.map((providerId) => `${providerId}.json`));
	for (const providerId of bundle.providerIds) {
		copyFileSync(join(bundle.providersDir, `${providerId}.json`), join(destProviders, `${providerId}.json`));
	}
	for (const name of readdirSync(destProviders)) {
		if (!name.endsWith(".json") || keep.has(name)) continue;
		rmSync(join(destProviders, name));
	}

	const leftover = join(outputDir, LEGACY_OFFICIAL_FILENAME);
	if (existsSync(leftover)) rmSync(leftover);

	const publication = {
		generatedAt: new Date().toISOString(),
		sourceCommit,
		providerCount: bundle.providerCount,
		modelCount: bundle.modelCount,
	};
	writeFileSync(join(outputDir, "publication.json"), `${JSON.stringify(publication, null, 2)}\n`);
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

	const publication = syncBundle(bundle, outputDir, options.sourceCommit || gitSourceCommit());
	console.log(JSON.stringify({ ...publication, output: outputDir, revision: bundle.revision }, null, 2));
}

main();
