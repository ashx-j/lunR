import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import { createProvider, hasApi, type Provider } from "../models.ts";
import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { claudeCodeContextWindow } from "../utils/claude-code-routes.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

export function anthropicProvider(): Provider<"anthropic-messages"> {
	const messages = anthropicMessagesApi();
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			options?.externalClaudeCode
				? subscriptionStream(model, context, options, false)
				: messages.stream(model, context, options),
		streamSimple: (model, context, options) =>
			options?.externalClaudeCode
				? subscriptionStream(model, context, options, true)
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
		filterModels: (models, credential) => {
			if (credential?.type !== "external_claude_code") return models;
			const routes = credential.routes ?? [];
			const rank = (id: string) => routes.findIndex((route) => route === id || route === `${id}[1m]`);
			// Claude Code's picker order, so its default for the plan comes first. A route with a smaller
			// window than the catalog's (Opus 5) caps the model so compaction runs before Claude Code's limit.
			return models
				.filter((model) => rank(model.id) >= 0)
				.sort((a, b) => rank(a.id) - rank(b.id))
				.map((model) => {
					const window = claudeCodeContextWindow(model.id);
					return window && window < model.contextWindow ? { ...model, contextWindow: window } : model;
				});
		},
		api,
	});
}

/** Claude subscription turns run through lunR's pinned Claude Code; the bridge loads on first use. */
function subscriptionStream(
	model: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions,
	simple: boolean,
) {
	return lazyStream(model, async () => {
		if (!hasApi(model, "anthropic-messages")) throw new Error(`Claude Code cannot serve ${model.api} models`);
		// A computed specifier keeps browser bundlers out of the Node-only bridge.
		const specifier = import.meta.url.endsWith(".js")
			? "../api/anthropic-claude-code-bridge.js"
			: "../api/anthropic-claude-code-bridge.ts";
		const { streamClaudeCode } = (await import(specifier)) as typeof import("../api/anthropic-claude-code-bridge.ts");
		return streamClaudeCode(model, context, options, simple);
	});
}
