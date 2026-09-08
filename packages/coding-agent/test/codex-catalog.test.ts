import { describe, expect, it } from "vitest";
import { discoverCodexModels } from "../src/core/codex-catalog.ts";

describe("Codex model discovery", () => {
	it("maps native none reasoning and respects an explicitly empty effort list", () => {
		const [optional, plain] = discoverCodexModels(
			{
				models: [
					{
						slug: "optional",
						visibility: "list",
						supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }],
					},
					{ slug: "plain", visibility: "list", supported_reasoning_levels: [] },
				],
			},
			"https://chatgpt.com/backend-api",
		);
		expect(optional.model.thinkingLevelMap?.off).toBe("none");
		expect(plain.model.reasoning).toBe(false);
		expect(plain.model.catalog?.supplied).toContain("reasoning");
	});

	it("does not promote a maximum window to the default compaction budget", () => {
		const [model] = discoverCodexModels(
			{
				models: [
					{
						slug: "max-only",
						visibility: "list",
						max_context_window: 872000,
					},
				],
			},
			"https://chatgpt.com/backend-api",
		);

		expect(model.model.contextWindow).toBe(128000);
		expect(model.supplied.contextWindow).toBe(false);
	});

	it("preserves an explicitly advertised 372k default window", () => {
		const [model] = discoverCodexModels(
			{
				models: [
					{
						slug: "explicit-372k",
						visibility: "hide",
						context_window: 372000,
						max_context_window: 372000,
					},
				],
			},
			"https://chatgpt.com/backend-api",
		);

		expect(model.model.contextWindow).toBe(372000);
		expect(model.supplied.contextWindow).toBe(true);
	});

	it("discovers an unseen model without a baked-in entry", () => {
		const models = discoverCodexModels(
			{
				models: [
					{
						slug: "future-coding-model",
						display_name: "Future",
						visibility: "list",
						context_window: 272000,
						max_context_window: 872000,
						input_modalities: ["text", "image"],
						supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
					},
				],
			},
			"https://chatgpt.com/backend-api",
		);
		expect(models).toHaveLength(1);
		expect(models[0].model).toMatchObject({
			id: "future-coding-model",
			provider: "openai-codex",
			api: "openai-codex-responses",
			contextWindow: 272000,
			input: ["text", "image"],
			thinkingLevelMap: { low: "low", medium: null, high: "high", max: null },
		});
	});
});
