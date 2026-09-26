import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

export function anthropicProvider(): Provider<"anthropic-messages"> {
	const messages = anthropicMessagesApi();
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			options?.externalClaudeCode
				? subscriptionStream(model, context, options)
				: messages.stream(model, context, options),
		streamSimple: (model, context, options) =>
			options?.externalClaudeCode
				? subscriptionStream(model, context, options)
				: messages.streamSimple(model, context, options),
	};
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]),
			oauth: lazyOAuth({ name: "Anthropic (Claude Pro/Max)", load: loadAnthropicOAuth }),
		},
		models: Object.values(ANTHROPIC_MODELS),
		filterModels: (models, credential) =>
			credential?.type === "external_claude_code"
				? models.filter(
						(model) => credential.routes?.includes(model.id) || credential.routes?.includes(`${model.id}[1m]`),
					)
				: models,
		api,
	});
}

function subscriptionStream(model: Model<Api>, context: Context, options: StreamOptions | SimpleStreamOptions) {
	return lazyStream(model, async () => {
		const specifier = import.meta.url.endsWith(".js")
			? "../api/anthropic-claude-code-bridge.js"
			: "../api/anthropic-claude-code-bridge.ts";
		const { streamClaudeCode } = (await import(specifier)) as typeof import("../api/anthropic-claude-code-bridge.ts");
		return streamClaudeCode(model, context, options);
	});
}
