import { afterEach, describe, expect, it } from "vitest";
import { type ModelsDevModel, modelFromModelsDev } from "../src/catalog/models-dev.ts";
import { MODELS_DEV_SOURCES } from "../src/catalog/providers.ts";
import { getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	const together = MODELS_DEV_SOURCES.find((source) => source.provider === "together")!;
	const build = (row: ModelsDevModel) => {
		const route = together.route!("model", row)!;
		return modelFromModelsDev("model", row, {
			provider: "together",
			api: together.api,
			baseUrl: together.baseUrl,
			compat: route.compat,
		});
	};

	it("serves catalog models through Together's chat completions endpoint", () => {
		const models = getModels("together");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.together.ai/v1");
		}
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const effort = build({
			reasoning: true,
			reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
		});
		expect(effort.thinkingLevelMap).toEqual({ off: null, minimal: null });
		expect(effort.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: "openai" });

		const toggle = build({ reasoning: true, reasoning_options: [{ type: "toggle" }] });
		expect(toggle.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(toggle.compat).toMatchObject({ supportsReasoningEffort: false, thinkingFormat: "together" });

		const both = build({
			reasoning: true,
			reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
		});
		expect(both.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: "together" });

		// Always reasons: neither reasoning field is sent.
		const always = build({ reasoning: true, reasoning_options: [] });
		expect(always.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(always.compat).toMatchObject({ supportsReasoningEffort: false, thinkingFormat: "openai" });
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
