import { InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function cachedXaiModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelRuntime.create startup", () => {
	it("does not wait on a hung remote catalog fetch", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const started = Date.now();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				xai: { type: "api_key", key: "test-key" },
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(runtime.getModels("xai").length).toBeGreaterThan(0);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("applies a persisted live overlay and bundled official without going to the network", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("xai", {
			models: [cachedXaiModel("cached-only-model")],
			checkedAt: Date.now(),
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				xai: { type: "api_key", key: "test-key" },
			}),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: true,
		});
		expect(runtime.getModel("xai", "cached-only-model")).toBeDefined();
		expect(runtime.getModel("xai", "grok-4.6")).toBeDefined();
		expect(fetch).not.toHaveBeenCalled();
	});
});
