import { InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime, refreshModelCandidatesForInit } from "../src/core/model-runtime.ts";

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

	it("refreshModelCandidatesForInit is cache-only and does not fetch", async () => {
		const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				xai: { type: "api_key", key: "test-key" },
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});
		fetchImpl.mockClear();
		const models = await refreshModelCandidatesForInit(runtime);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(models.some((model) => model.provider === "xai")).toBe(true);
	});

	it("cache-only refresh waits for a hung live official fetch and does not regress it", async () => {
		let releaseOfficial: (() => void) | undefined;
		const officialGate = new Promise<void>((resolve) => {
			releaseOfficial = resolve;
		});
		const liveOnlyId = "grok-single-flight-only";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const href = String(url);
			if (href.endsWith("/providers.json")) {
				await officialGate;
				return new Response(JSON.stringify(["xai"]), { status: 200 });
			}
			if (href.endsWith("/providers/xai.json")) {
				return new Response(
					JSON.stringify({
						[liveOnlyId]: {
							id: liveOnlyId,
							name: "Grok single-flight",
							api: "openai-completions",
							provider: "xai",
							baseUrl: "https://api.x.ai/v1",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 3, output: 9, cacheRead: 0.5, cacheWrite: 0 },
							contextWindow: 600000,
							maxTokens: 600000,
						},
					}),
					{ status: 200 },
				);
			}
			if (href.includes("/models")) {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			return new Response("missing", { status: 404 });
		});

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				xai: { type: "api_key", key: "test-key" },
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});
		expect(runtime.getModel("xai", liveOnlyId)).toBeUndefined();

		const live = runtime.refresh({ allowNetwork: true });
		const cacheOnly = runtime.refresh({ allowNetwork: false });
		releaseOfficial?.();
		await Promise.all([live, cacheOnly]);
		expect(runtime.getModel("xai", liveOnlyId)).toBeDefined();

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("xai", liveOnlyId)).toBeDefined();
	});
});
