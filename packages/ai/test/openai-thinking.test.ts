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
			expect(model?.name).toBe("GPT-6 Astra");
			expect(model?.reasoning).toBe(true);
			expect(model?.contextWindow).toBe(1050000);
			expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});

	it("publishes GPT-6 Astra in every official catalog shard used by refresh", () => {
		for (const provider of ["openai", "openai-codex", "azure-openai-responses"]) {
			const model = loadCatalogProvider(provider)["gpt-6-astra"];
			expect(model).toBeDefined();
			expect(model.provider).toBe(provider);
			// Codex's default conversation limit is not the OpenAI API's maximum window.
			expect(model.contextWindow).toBe(provider === "openai-codex" ? 272000 : 1050000);
			expect(model.maxTokens).toBe(128000);
			if (provider !== "azure-openai-responses") {
				expect(model.compat).toMatchObject({ supportsToolSearch: true });
			}
			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});
});
