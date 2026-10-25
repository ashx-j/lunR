import { describe, expect, it } from "vitest";
import {
	type ModelsDevCatalog,
	ModelsDevFacts,
	type ModelsDevModel,
	modelFromModelsDev,
	modelsDevThinkingLevelMap,
} from "../src/catalog/models-dev.ts";
import { modelsDevModels } from "../src/catalog/providers.ts";
import { applyCatalogRules } from "../src/catalog/rules.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

const tool = { tool_call: true, modalities: { input: ["text"], output: ["text"] } } satisfies ModelsDevModel;
const target = { provider: "example", api: "openai-completions", baseUrl: "https://example.test/v1" } as const;

function levels(row: ModelsDevModel, api: typeof target.api | "anthropic-messages" = target.api) {
	return getSupportedThinkingLevels(modelFromModelsDev("m", { ...tool, ...row }, { ...target, api }));
}

describe("models.dev catalog", () => {
	it("lists a model the day models.dev adds it, with no lunR code change", () => {
		const data: ModelsDevCatalog = {
			anthropic: {
				models: {
					"claude-opus-9": {
						...tool,
						name: "Claude Opus 9",
						family: "claude-opus",
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
						temperature: false,
						limit: { context: 2000000, output: 256000 },
					},
				},
			},
		};
		const model = modelsDevModels(data, new ModelsDevFacts(data)).find((m) => m.id === "claude-opus-9");
		expect(model).toMatchObject({
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 2000000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
		});
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
	});

	it("skips rows that cannot call tools or answer in text", () => {
		const data: ModelsDevCatalog = {
			groq: {
				models: {
					embed: { tool_call: false },
					speech: { tool_call: true, modalities: { output: ["audio"] } },
					chat: tool,
				},
			},
		};
		expect(modelsDevModels(data, new ModelsDevFacts(data)).map((m) => m.id)).toEqual(["chat"]);
	});

	it("derives thinking levels from reasoning options", () => {
		const effort = (values: string[]) => [{ type: "effort" as const, values }];
		// "none" turns thinking off; levels the model does not list are hidden.
		expect(
			levels({ reasoning: true, reasoning_options: effort(["none", "low", "medium", "high", "xhigh"]) }),
		).toEqual(["off", "low", "medium", "high", "xhigh"]);
		// Effort without "none" or a toggle cannot be turned off.
		expect(levels({ reasoning: true, reasoning_options: effort(["low", "high", "max"]) })).toEqual([
			"low",
			"high",
			"max",
		]);
		// Toggle only: on or off.
		expect(levels({ reasoning: true, reasoning_options: [{ type: "toggle" }] })).toEqual(["off", "high"]);
		// Always reasons with no controls.
		expect(levels({ reasoning: true, reasoning_options: [] })).toEqual(["high"]);
		// A single host-specific "on" value becomes high.
		expect(
			modelsDevThinkingLevelMap({ reasoning: true, reasoning_options: effort(["none", "default"]) }, target.api),
		).toMatchObject({ off: "none", high: "default" });
		// Unknown options keep transport defaults.
		expect(modelsDevThinkingLevelMap({ reasoning: true }, target.api)).toBeUndefined();
	});

	it("keeps budget thinking for non-Claude models on Anthropic-compatible hosts", () => {
		const row: ModelsDevModel = {
			...tool,
			family: "glm",
			reasoning: true,
			reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
		};
		const model = modelFromModelsDev("glm", row, { ...target, api: "anthropic-messages" });
		expect(model.compat).toBeUndefined();
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("reads long-context price tiers", () => {
		const model = modelFromModelsDev(
			"m",
			{
				...tool,
				cost: { input: 5, output: 30, tiers: [{ input: 10, output: 45, tier: { type: "context", size: 272000 } }] },
			},
			target,
		);
		expect(model.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 0, cacheWrite: 0 }],
		});
	});
});

describe("models.dev facts", () => {
	const data: ModelsDevCatalog = {
		anthropic: {
			models: {
				"claude-opus-5-5": {
					family: "claude-opus",
					temperature: false,
					reasoning_options: [{ type: "effort", values: ["low", "max"] }],
				},
			},
		},
		vercel: {
			models: {
				"anthropic/claude-opus-5.5": { temperature: true, canonical_model_id: "anthropic/claude-opus-5-5" },
			},
		},
	};
	const facts = new ModelsDevFacts(data);

	it("fills a host's missing capabilities from the lab's row", () => {
		expect(facts.complete(data.vercel.models["anthropic/claude-opus-5.5"])).toMatchObject({
			family: "claude-opus",
			temperature: false,
			reasoning_options: [{ type: "effort", values: ["low", "max"] }],
		});
	});

	it("finds facts for gateway variants and ids that extend a known model", () => {
		expect(facts.find("~anthropic/claude-opus-5-5:batch")?.family).toBe("claude-opus");
		expect(facts.find("claude-opus-5-5-backup")?.family).toBe("claude-opus");
		expect(facts.find("gpt-9")).toBeUndefined();
	});
});

describe("catalog rules", () => {
	const base = modelFromModelsDev(
		"claude-opus-5-5",
		{ ...tool, reasoning: true },
		{
			...target,
			provider: "anthropic",
			api: "anthropic-messages",
		},
	);

	it("merges thinking levels and compat into the model", () => {
		expect(
			applyCatalogRules(base, [{ match: /opus/, set: { thinkingLevelMap: { off: null } }, why: "test" }])
				?.thinkingLevelMap,
		).toEqual({ off: null });
	});

	it("drops a model only when a rule says so", () => {
		expect(applyCatalogRules(base, [{ providers: ["openai"], match: /.*/, drop: true, why: "test" }])).toBe(base);
		expect(applyCatalogRules(base, [{ providers: ["anthropic"], match: /.*/, drop: true, why: "test" }])).toBe(
			undefined,
		);
	});
});
