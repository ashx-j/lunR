import { describe, expect, it, vi } from "vitest";
import { cycleModel, type ModelSelectionHost } from "../src/core/model-selection.ts";

describe("cycleModel with scoped models", () => {
	it("skips scoped models without auth and applies the next model's scoped thinking level", async () => {
		const a = { provider: "p", id: "a" };
		const b = { provider: "nokey", id: "b" };
		const c = { provider: "p", id: "c" };
		const state = { model: a, thinkingLevel: "low" };
		const host = {
			agent: { state },
			get model() {
				return state.model;
			},
			get thinkingLevel() {
				return state.thinkingLevel;
			},
			scopedModels: [{ model: a }, { model: b }, { model: c, thinkingLevel: "high" }],
			modelRuntime: { checkAuth: async (provider: string) => (provider === "nokey" ? undefined : {}) },
			sessionManager: { appendModelChange: vi.fn() },
			settingsManager: { setDefaultModelAndProvider: vi.fn() },
			extensionRunner: { emit: vi.fn(async () => {}) },
			syncOpenAIServiceTier: vi.fn(),
			refreshSystemPromptForCurrentModel: vi.fn(),
			setThinkingLevel: vi.fn((level: string) => {
				state.thinkingLevel = level;
			}),
		};
		const result = await cycleModel(host as unknown as ModelSelectionHost);
		expect(result).toEqual({ model: c, thinkingLevel: "high", isScoped: true });
		expect(host.sessionManager.appendModelChange).toHaveBeenCalledWith("p", "c");
		expect(host.extensionRunner.emit).toHaveBeenCalledWith({
			type: "model_select",
			model: c,
			previousModel: a,
			source: "cycle",
		});
	});
});
