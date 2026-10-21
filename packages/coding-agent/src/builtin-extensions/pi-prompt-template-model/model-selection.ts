import type { Api, Model } from "@earendil-works/pi-ai";
import type { ResolvedModelRef } from "./template-conditionals.ts";

const PREFERRED_PROVIDERS = ["openai-codex", "anthropic", "github-copilot", "openrouter"];

export interface SelectedModelCandidate {
	model: Model<Api>;
	alreadyActive: boolean;
}

export interface RegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	isUsingOAuth(model: Model<Api>): boolean;
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
	getApiKeyAndHeaders?: (model: Model<Api>) => Promise<{
		ok: boolean;
		apiKey?: string;
		headers?: Record<string, string>;
		error?: string;
	}>;
}

function isSameModel(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function modelSpecMatches(modelSpec: string, model: Model<Api>): boolean {
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		return provider === model.provider && modelId === model.id;
	}

	return modelSpec === model.id;
}

function orderMatchesByProviderPreference(models: Model<Api>[]): Model<Api>[] {
	const prioritized: Model<Api>[] = [];
	const seen = new Set<string>();

	for (const provider of PREFERRED_PROVIDERS) {
		for (const model of models) {
			const key = `${model.provider}/${model.id}`;
			if (model.provider === provider && !seen.has(key)) {
				prioritized.push(model);
				seen.add(key);
			}
		}
	}

	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) {
			prioritized.push(model);
			seen.add(key);
		}
	}

	return prioritized;
}

function getModelCandidates(modelSpec: string, registry: Pick<RegistryLike, "find" | "getAll">): Model<Api>[] {
	const slashIndex = modelSpec.indexOf("/");

	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		if (!provider || !modelId) return [];
		if (modelId.split("/").some((segment) => segment.length === 0)) return [];
		const model = registry.find(provider, modelId);
		return model ? [model] : [];
	}

	const allMatches = registry.getAll().filter((model) => model.id === modelSpec);
	if (allMatches.length <= 1) return allMatches;
	return orderMatchesByProviderPreference(allMatches);
}

async function hasUsableAuth(model: Model<Api>, registry: RegistryLike): Promise<boolean> {
	const availableMatch = registry.getAvailable().some((candidate) => isSameModel(candidate, model));
	if (availableMatch) return true;
	if (!registry.isUsingOAuth(model)) return false;
	if (registry.hasConfiguredAuth) return registry.hasConfiguredAuth(model);
	if (registry.getApiKeyAndHeaders) {
		const auth = await registry.getApiKeyAndHeaders(model);
		return auth.ok;
	}
	return false;
}

export async function selectModelCandidate(
	modelSpecs: string[],
	currentModel: Model<Api> | undefined,
	registry: RegistryLike,
): Promise<SelectedModelCandidate | undefined> {
	if (currentModel && modelSpecs.some((spec) => modelSpecMatches(spec, currentModel))) {
		return { model: currentModel, alreadyActive: true };
	}

	for (const spec of modelSpecs) {
		for (const model of getModelCandidates(spec, registry)) {
			if (await hasUsableAuth(model, registry)) {
				return { model, alreadyActive: false };
			}
		}
	}

	return undefined;
}

export function getResolvedModelRef(model: Model<Api>): ResolvedModelRef {
	return { provider: model.provider, id: model.id };
}
