import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchModelDetails,
	fetchModelIds,
	refreshOllamaCloudModels,
} from "../src/builtin-extensions/pi-ollama-cloud/models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Ollama Cloud canonical discovery auth", () => {
	it.each([false, true])(
		"matches inference with runtime override %s and ignores a different ambient key",
		async (override) => {
			vi.stubEnv("OLLAMA_API_KEY", "fake-ambient");
			vi.stubEnv("OLLAMA_STORED_TEST_KEY", "fake-resolved");
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ "ollama-cloud": { type: "api_key", key: "$OLLAMA_STORED_TEST_KEY" } }),
				modelsPath: null,
				allowModelNetwork: false,
			});
			// Match the builtin extension's registered API-key provider.
			runtime.registerProvider("ollama-cloud", {
				baseUrl: "https://ollama.com/v1",
				apiKey: "OLLAMA_API_KEY",
				api: "openai-completions",
				models: [
					{
						id: "fake-model",
						name: "Fake",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 10000,
						maxTokens: 1000,
					},
				],
			});
			if (override) await runtime.setRuntimeApiKey("ollama-cloud", "fake-runtime", { allowNetwork: false });
			const resolved = await runtime.getAuth("ollama-cloud");
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "fake-model" }] })));
			const auth = { apiKey: resolved?.auth.apiKey };
			await fetchModelIds(auth, 50);
			await fetchModelDetails("fake-model", auth, 50);
			for (const call of fetch.mock.calls)
				expect(call[1]?.headers).toMatchObject({
					Authorization: `Bearer ${override ? "fake-runtime" : "fake-resolved"}`,
				});
		},
	);

	it("preserves canonical Authorization headers instead of replacing them with the key", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify({ data: [] })));
		await fetchModelIds({ apiKey: "fake-key", headers: { authorization: "Bearer fake-selected-header" } }, 50);
		expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer fake-selected-header" });
	});

	it("dispatches nothing without canonical auth, even with ambient credentials", async () => {
		vi.stubEnv("OLLAMA_API_KEY", "fake-ambient");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fake transport guard"));
		expect(await refreshOllamaCloudModels({})).toEqual({});
		expect(fetch).not.toHaveBeenCalled();
	});
});
