import { describe, expect, it, vi } from "vitest";
import {
	cycleModel,
	getAvailableThinkingLevels,
	type ModelSelectionHost,
	setModel,
	setThinkingLevel,
	supportsThinking,
} from "../src/core/model-selection.ts";

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
			dropModelResources: vi.fn(),
			refreshSystemPromptForCurrentModel: vi.fn(),
			setThinkingLevel: vi.fn((level: string) => {
				state.thinkingLevel = level;
			}),
		};
		const result = await cycleModel(host as unknown as ModelSelectionHost);
		expect(result).toEqual({ model: c, thinkingLevel: "high", isScoped: true });
		expect(host.sessionManager.appendModelChange).toHaveBeenCalledWith("p", "c");
		expect(host.dropModelResources).toHaveBeenCalledWith(a);
		expect(host.extensionRunner.emit).toHaveBeenCalledWith({
			type: "model_select",
			model: c,
			previousModel: a,
			source: "cycle",
		});
	});

	it("without scoped models, cycles the available models and drops the previous model's resources", async () => {
		const a = { provider: "p", id: "a" };
		const b = { provider: "p", id: "b" };
		const state = { model: a, thinkingLevel: "off" };
		const host = {
			agent: { state },
			get model() {
				return state.model;
			},
			get thinkingLevel() {
				return state.thinkingLevel;
			},
			scopedModels: [],
			modelRuntime: { getAvailable: async () => [a, b] },
			sessionManager: { appendModelChange: vi.fn() },
			settingsManager: { setDefaultModelAndProvider: vi.fn(), getDefaultThinkingLevel: () => undefined },
			extensionRunner: { emit: vi.fn(async () => {}) },
			syncOpenAIServiceTier: vi.fn(),
			dropModelResources: vi.fn(),
			refreshSystemPromptForCurrentModel: vi.fn(),
			setThinkingLevel: vi.fn(),
			supportsThinking: () => false,
		};
		const result = await cycleModel(host as unknown as ModelSelectionHost);
		expect(result).toEqual({ model: b, thinkingLevel: "off", isScoped: false });
		expect(host.dropModelResources).toHaveBeenCalledWith(a);
	});
});

describe("setThinkingLevel after a catalog refresh", () => {
	it("clamps to the levels the refreshed catalog offers, not the stale session model's", () => {
		// The session still holds the old model object; the catalog now marks xhigh unsupported.
		const stale = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
		const refreshed = { ...stale, thinkingLevelMap: { xhigh: null } };
		const state = { model: stale, thinkingLevel: "medium" };
		const host: Record<string, unknown> = {
			agent: { state },
			get model() {
				return state.model;
			},
			modelRuntime: { getModel: () => refreshed },
			sessionManager: { appendThinkingLevelChange: vi.fn() },
			settingsManager: { setDefaultThinkingLevel: vi.fn() },
			extensionRunner: { emit: vi.fn(async () => {}) },
			emit: vi.fn(),
			supportsThinking: () => true,
		};
		host.getAvailableThinkingLevels = () => getAvailableThinkingLevels(host as unknown as ModelSelectionHost);
		expect(getAvailableThinkingLevels(host as unknown as ModelSelectionHost)).not.toContain("xhigh");
		setThinkingLevel(host as unknown as ModelSelectionHost, "xhigh");
		expect(state.thinkingLevel).toBe("high");
	});
});

describe("model switches and the spare Claude Code process", () => {
	it("setModel drops the resources prepared for the previous model", async () => {
		const previous = { provider: "p", id: "old" };
		const next = { provider: "p", id: "new" };
		const state = { model: previous, thinkingLevel: "off" };
		const host = {
			agent: { state },
			get model() {
				return state.model;
			},
			modelRuntime: { checkAuth: async () => ({}) },
			sessionManager: { appendModelChange: vi.fn() },
			settingsManager: { setDefaultModelAndProvider: vi.fn(), getDefaultThinkingLevel: () => undefined },
			extensionRunner: { emit: vi.fn(async () => {}) },
			syncOpenAIServiceTier: vi.fn(),
			dropModelResources: vi.fn(),
			refreshSystemPromptForCurrentModel: vi.fn(),
			setThinkingLevel: vi.fn(),
			supportsThinking: () => false,
		};
		await setModel(host as unknown as ModelSelectionHost, next as never);
		expect(host.dropModelResources).toHaveBeenCalledWith(previous);
	});
});

describe("setThinkingLevel when the refreshed catalog drops reasoning", () => {
	it("stores off without saving it as the user's default", async () => {
		const stale = { provider: "p", id: "m", reasoning: true };
		const refreshed = { ...stale, reasoning: false };
		const state = { model: stale, thinkingLevel: "medium" };
		const setDefaultThinkingLevel = vi.fn();
		const host: Record<string, unknown> = {
			agent: { state },
			get model() {
				return state.model;
			},
			modelRuntime: { getModel: () => refreshed },
			sessionManager: { appendThinkingLevelChange: vi.fn() },
			settingsManager: { setDefaultThinkingLevel },
			extensionRunner: { emit: vi.fn(async () => {}) },
			emit: vi.fn(),
		};
		// As AgentSession wires them: both read the registry copy of the model.
		host.getAvailableThinkingLevels = () => getAvailableThinkingLevels(host as unknown as ModelSelectionHost);
		host.supportsThinking = () => supportsThinking(host as unknown as ModelSelectionHost);
		setThinkingLevel(host as unknown as ModelSelectionHost, "high");
		expect(state.thinkingLevel).toBe("off");
		expect(setDefaultThinkingLevel).not.toHaveBeenCalled();
	});
});
