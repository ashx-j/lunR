import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import lunrLocalProviders from "../src/builtin-extensions/lunr-local-providers/index.ts";
import { LOCAL_SERVERS } from "../src/builtin-extensions/lunr-local-providers/local-servers.ts";
import type { ExtensionAPI, ProviderConfig } from "../src/core/extensions/types.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function captureProviders(): Map<string, ProviderConfig> {
	const providers = new Map<string, ProviderConfig>();
	const pi = {
		on() {},
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
		},
	} as unknown as ExtensionAPI;
	lunrLocalProviders(pi);
	return providers;
}

describe("lunr local providers", () => {
	it("probes 127.0.0.1 instead of localhost", () => {
		expect(LOCAL_SERVERS.map((spec) => spec.modelsUrl)).toEqual([
			"http://127.0.0.1:11434/v1/models",
			"http://127.0.0.1:1234/v1/models",
		]);
	});

	it("cache-only refreshModels uses the store and does not fetch", async () => {
		const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const providers = captureProviders();
		const refresh = providers.get("ollama-local")?.refreshModels;
		expect(refresh).toBeTypeOf("function");
		const store = new InMemoryModelsStore();
		await store.write("ollama-local", {
			models: [
				{
					id: "cached-llama",
					name: "cached-llama",
					api: "openai-completions",
					provider: "ollama-local",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 8192,
				},
			],
			checkedAt: Date.now(),
		});
		const started = Date.now();
		const models = await refresh!({
			allowNetwork: false,
			store: {
				read: () => store.read("ollama-local"),
				write: (entry) => store.write("ollama-local", entry),
				delete: () => store.delete("ollama-local"),
			},
		});
		expect(Date.now() - started).toBeLessThan(200);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(models.map((model) => model.id)).toEqual(["cached-llama"]);
	});
});
