import type { Api, Model } from "../src/types.ts";

/**
 * Catalog rows for openai-completions tests whose providers lunR no longer ships, as the catalog last
 * had them. Their compat settings stay for custom providers in models.json.
 */
const FIXTURES = {
	"ant-ling": {
		"Ring-2.6-1T": {
			id: "Ring-2.6-1T",
			name: "Ring 2.6 1T",
			api: "openai-completions",
			provider: "ant-ling",
			baseUrl: "https://api.ant-ling.com/v1",
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsLongCacheRetention: false,
				thinkingFormat: "ant-ling",
			},
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "xhigh",
			},
			input: ["text"],
			cost: {
				input: 0.06,
				output: 0.25,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
		},
		"Ling-2.6-flash": {
			id: "Ling-2.6-flash",
			name: "Ling 2.6 Flash",
			api: "openai-completions",
			provider: "ant-ling",
			baseUrl: "https://api.ant-ling.com/v1",
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsLongCacheRetention: false,
			},
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
		},
	},
} as const;

type FixtureApi<
	P extends keyof typeof FIXTURES,
	I extends keyof (typeof FIXTURES)[P],
> = (typeof FIXTURES)[P][I] extends {
	api: infer TApi;
}
	? TApi extends Api
		? TApi
		: never
	: never;

/** A copy of one fixture row, typed like `getModel`. */
export function fixtureModel<P extends keyof typeof FIXTURES, I extends keyof (typeof FIXTURES)[P]>(
	provider: P,
	id: I,
): Model<FixtureApi<P, I>> {
	return structuredClone(FIXTURES[provider][id]) as unknown as Model<FixtureApi<P, I>>;
}
