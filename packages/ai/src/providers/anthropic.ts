import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import type { ClaudeCodeModelRoute } from "../auth/types.ts";
import { createProvider, hasApi, type Provider } from "../models.ts";
import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";
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
		// A subscription lists what Claude Code offered at setup, in its picker order, with or without a catalog
		// row. A window saved for the route replaces the catalog's, so compaction runs before Claude Code's limit.
		filterModels: (models, credential) =>
			credential?.type === "external_claude_code"
				? (credential.models ?? []).map((offered) => {
						const model = models.find((candidate) => candidate.id === offered.id);
						if (!model) return offeredModel(offered, models);
						return offered.contextWindow === undefined || model.contextWindow === offered.contextWindow
							? model
							: { ...model, contextWindow: offered.contextWindow };
					})
				: models,
		api,
	});
}

/**
 * A model the subscription offers before lunR's catalog has it. The picker's facts win: the id, the `[1m]`
 * route's window and the name from Claude Code's description ("Opus 5.5 · Best for ..."). Thinking, output
 * limit, price and the default window come from the catalog row of the same family (`claude-fable`) that
 * shares the most leading id segments, newest first, so `claude-fable-5-2` borrows from `claude-fable-5-1`.
 * The borrowed price is marked unknown. With no row of the family, the model gets the defaults
 * `discoveredModel` gives a model nothing is known about: 128k context, 8k output and no thinking controls,
 * so lunR sends no thinking setting and Claude Code keeps its own.
 */
function offeredModel(
	offered: ClaudeCodeModelRoute,
	models: readonly Model<"anthropic-messages">[],
): Model<"anthropic-messages"> {
	const segments = offered.id.split("-");
	const shared = (id: string) => {
		const other = id.split("-");
		let count = 0;
		while (count < segments.length && segments[count] === other[count]) count++;
		return count;
	};
	let template: Model<"anthropic-messages"> | undefined;
	for (const model of models) {
		const count = shared(model.id);
		const best = template ? shared(template.id) : FAMILY_SEGMENTS - 1;
		if (count > best || (count === best && template && newerId(model.id, template.id))) template = model;
	}
	const name = offered.description?.split(" · ")[0]?.trim() || offered.id;
	const supplied: NonNullable<Model<"anthropic-messages">["catalog"]>["supplied"] = [];
	if (name !== offered.id) supplied.push("name");
	if (offered.contextWindow) supplied.push("contextWindow");
	const catalog = { source: "provider", supplied, pricing: "unknown" } as const;
	if (template) {
		return {
			...template,
			id: offered.id,
			name,
			contextWindow: offered.contextWindow ?? template.contextWindow,
			catalog,
		};
	}
	return {
		id: offered.id,
		name,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: offered.contextWindow ?? 128_000,
		maxTokens: 8192,
		catalog,
	};
}

/** `claude` and the family name. */
const FAMILY_SEGMENTS = 2;

const newerId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true }) > 0;

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
