import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ModelsDevProviderDefinition } from "../catalog/providers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MODELS_DEV_PROVIDERS } from "./models-dev-providers.generated.ts";

/**
 * A provider lunR builds from its models.dev listing. It starts with no models; its catalog rows
 * arrive with the published catalog after login, and its own model list is read like any other.
 */
export function modelsDevProvider(definition: ModelsDevProviderDefinition): Provider {
	return createProvider({
		id: definition.id,
		name: definition.name,
		baseUrl: definition.baseUrl,
		auth: { apiKey: envApiKeyAuth(`${definition.name} API key`, [...definition.env]) },
		models: [],
		api: definition.api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
	});
}

/** Every generic provider whose id no hand-written provider uses. */
export function modelsDevProviders(taken: ReadonlySet<string>): Provider[] {
	return MODELS_DEV_PROVIDERS.filter((definition) => !taken.has(definition.id)).map(modelsDevProvider);
}
