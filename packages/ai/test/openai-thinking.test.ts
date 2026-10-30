import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";
import {
	parseOpenAiGptVersion,
	supportsOpenAiMax,
	supportsOpenAiXhigh,
	withOpenAiEffortMetadata,
} from "../src/openai-effort.ts";
import type { Api, Model } from "../src/types.ts";

const catalogProvidersPath = join(dirname(fileURLToPath(import.meta.url)), "../../../catalog/providers");

function loadCatalogProvider(provider: string): Record<string, Model<Api>> {
	return JSON.parse(readFileSync(join(catalogProvidersPath, `${provider}.json`), "utf8")) as Record<
		string,
		Model<Api>
	>;
}

describe("parseOpenAiGptVersion", () => {
	it("parses dotted and named gpt ids", () => {
		expect(parseOpenAiGptVersion("gpt-5.2")).toEqual({ major: 5, minor: 2 });
		expect(parseOpenAiGptVersion("gpt-5.6-sol")).toEqual({ major: 5, minor: 6 });
		expect(parseOpenAiGptVersion("gpt-6-astra")).toEqual({ major: 6, minor: 0 });
		expect(parseOpenAiGptVersion("openai/gpt-6-astra")).toEqual({ major: 6, minor: 0 });
		expect(parseOpenAiGptVersion("gpt-5.3-codex")).toEqual({ major: 5, minor: 3 });
	});

	it("ignores non-gpt ids", () => {
		expect(parseOpenAiGptVersion("o3")).toBeUndefined();
		expect(parseOpenAiGptVersion("grok-4.6")).toBeUndefined();
	});
});

describe("OpenAI effort floors", () => {
	it("is a version floor, not a frozen gpt-5.6 id", () => {
		expect(supportsOpenAiXhigh("gpt-5")).toBe(false);
		expect(supportsOpenAiXhigh("gpt-5.1")).toBe(false);
		expect(supportsOpenAiXhigh("gpt-5.2")).toBe(true);
		expect(supportsOpenAiXhigh("gpt-6-astra")).toBe(true);
		expect(supportsOpenAiMax("gpt-5.5")).toBe(false);
		expect(supportsOpenAiMax("gpt-5.6-terra")).toBe(true);
		expect(supportsOpenAiMax("gpt-6-astra")).toBe(true);
		expect(supportsOpenAiMax("gpt-7-flagship")).toBe(true);
	});
});

describe("withOpenAiEffortMetadata", () => {
	it("stamps gpt-6 xhigh/max and reasoning onto a live completions-style row", () => {
		const stamped = withOpenAiEffortMetadata({
			id: "gpt-6-astra",
			provider: "openai",
			api: "openai-responses",
			reasoning: false,
		});
		expect(stamped.reasoning).toBe(true);
		expect(stamped.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("does not clobber gpt-5.6 none-reasoning off", () => {
		const stamped = withOpenAiEffortMetadata({
			id: "gpt-5.6-sol",
			provider: "openai",
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		});
		expect(stamped.thinkingLevelMap).toEqual({ off: "none", xhigh: "xhigh", max: "max" });
	});

	it("does not stamp models routed through unrelated providers", () => {
		const model = {
			id: "openai/gpt-6-astra",
			provider: "openrouter",
			api: "openai-completions",
			reasoning: false,
		};
		expect(withOpenAiEffortMetadata(model)).toBe(model);
	});
});

describe("GPT-6 Astra catalogs", () => {
	it("is baked in for openai and openai-codex with every supported effort", () => {
		for (const provider of ["openai", "openai-codex"] as const) {
			const model = getModel(provider, "gpt-6-astra");
			expect(model).toBeDefined();
			expect(model?.reasoning).toBe(true);
			// The OpenAI API serves 1.05M but bills more above 272k, so the catalog starts in the base
			// price tier; Codex OAuth's default context_window is 272k too.
			expect(model?.contextWindow).toBe(272000);
			expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
		"keeps the Codex default window for %s at 272k",
		(modelId) => {
			expect(getModel("openai-codex", modelId)?.contextWindow).toBe(272000);
			expect(loadCatalogProvider("openai-codex")[modelId]?.contextWindow).toBe(272000);
		},
	);

	it("publishes GPT-6 Astra in every official catalog shard used by refresh", () => {
		for (const provider of ["openai", "openai-codex"]) {
			const model = loadCatalogProvider(provider)["gpt-6-astra"];
			expect(model).toBeDefined();
			expect(model.provider).toBe(provider);
			// Codex's default conversation limit and the OpenAI API's base price tier are 272k.
			expect(model.contextWindow).toBe(272000);
			expect(model.maxTokens).toBe(128000);
			expect(model.compat).toMatchObject({ supportsToolSearch: true });
			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});
});
