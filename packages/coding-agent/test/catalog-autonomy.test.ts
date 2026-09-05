import { getSupportedThinkingLevels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { startCatalogRefreshPolling } from "../src/core/catalog-refresh-polling.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function credential(accountId = "account-a") {
	return {
		type: "oauth" as const,
		access: "test-access",
		refresh: "test-refresh",
		expires: Date.now() + 3600000,
		accountId,
	};
}

const future = {
	slug: "gpt-99-future-test",
	display_name: "Future Test",
	visibility: "list",
	context_window: 272000,
	input_modalities: ["text"],
	supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
};

function mockSources() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		const href = String(url);
		if (href.endsWith("/latest")) return Response.json({ version: "0.999.0" });
		if (href.includes("/codex/models?"))
			return Response.json({ models: [future, { ...future, slug: "internal-test", visibility: "hide" }] });
		if (href.endsWith("/providers.json")) return Response.json(["openai-codex"]);
		if (href.endsWith("/providers/openai-codex.json"))
			return Response.json({
				[future.slug]: {
					id: future.slug,
					name: "Stale",
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
					contextWindow: 1000000,
					maxTokens: 12345,
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
					thinkingLevelMap: { max: "max" },
				},
			});
		return new Response("missing", { status: 404 });
	});
}

describe("autonomous catalog runtime", () => {
	it("keeps explicit model configuration above refreshed provider capabilities", async () => {
		mockSources();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ "openai-codex": credential() }),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
		});
		await runtime.refresh();
		const discovered = runtime.getModel("openai-codex", future.slug)!;
		runtime.registerProvider("openai-codex", {
			models: [{ ...discovered, contextWindow: 64000, name: "Explicit override" }],
		});
		await runtime.refresh();
		expect(runtime.getAvailableSnapshot().find((row) => row.id === future.slug)).toMatchObject({
			contextWindow: 64000,
			name: "Explicit override",
		});
	});

	it("discards a response belonging to an account changed during discovery", async () => {
		const credentials = AuthStorage.inMemory({ "openai-codex": credential() });
		const modelsStore = new InMemoryModelsStore();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/latest")) return Response.json({ version: "0.999.0" });
			if (String(url).includes("/codex/models?")) {
				await credentials.modify("openai-codex", async () => credential("account-b"));
				return Response.json({ models: [future] });
			}
			return new Response("missing", { status: 404 });
		});
		const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null });
		await runtime.refresh();
		expect(runtime.getModel("openai-codex", future.slug)).toBeUndefined();
		expect(await modelsStore.read("openai-codex")).toBeUndefined();
	});

	it("discovers a future account model over stale published metadata without manual input", async () => {
		const fetch = mockSources();
		const credentials = AuthStorage.inMemory({ "openai-codex": credential() });
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null });
		expect(fetch).not.toHaveBeenCalled();
		await runtime.refreshIfStale();
		const model = runtime.getAvailableSnapshot().find((row) => row.id === future.slug)!;
		expect(model).toMatchObject({ contextWindow: 272000, maxTokens: 12345, input: ["text"], cost: { input: 10 } });
		expect(getSupportedThinkingLevels(model)).toEqual(["low"]);
		expect(model.catalog?.reasoningLevels).toContain("ultra");
		expect(
			runtime
				.getAvailableSnapshot()
				.filter((row) => row.provider === "openai-codex")
				.map((row) => row.id),
		).toEqual([future.slug]);
		const discovery = fetch.mock.calls.find(([url]) => String(url).includes("/codex/models?"))!;
		expect(String(discovery[0])).toContain("client_version=0.999.0");
		expect(new Headers(discovery[1]?.headers).get("ChatGPT-Account-ID")).toBe("account-a");
		const release = fetch.mock.calls.find(([url]) => String(url).endsWith("/latest"))!;
		expect(new Headers(release[1]?.headers).has("Authorization")).toBe(false);
		const count = fetch.mock.calls.length;
		await runtime.refreshIfStale();
		expect(fetch).toHaveBeenCalledTimes(count);
		await runtime.refresh({ force: true });
		expect(fetch.mock.calls.length).toBeGreaterThan(count);
	});

	it("restores a scoped cache offline and rejects it after account changes", async () => {
		mockSources();
		const credentials = AuthStorage.inMemory({ "openai-codex": credential() });
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null });
		await runtime.refresh();
		const offline = await ModelRuntime.create({
			credentials,
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});
		expect(offline.getModel("openai-codex", future.slug)).toBeDefined();
		await credentials.modify("openai-codex", async () => credential("account-b"));
		await offline.refresh({ allowNetwork: false });
		expect(offline.getModel("openai-codex", future.slug)).toBeUndefined();
	});

	it("keeps the last-good list on provider failure", async () => {
		const fetch = mockSources();
		const credentials = AuthStorage.inMemory({ "openai-codex": credential() });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
		});
		await runtime.refresh();
		fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
		const result = await runtime.refresh();
		expect(result.errors.has("openai-codex")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((row) => row.id === future.slug)).toBe(true);
	});

	it("does not change an active turn and cancels polling on shutdown", async () => {
		vi.useFakeTimers();
		let busy = true;
		const refresh = vi.fn(async () => {});
		const update = vi.fn();
		const stop = startCatalogRefreshPolling({ refresh, isBusy: () => busy, onUpdate: update });
		expect(refresh).not.toHaveBeenCalled();
		busy = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(update).toHaveBeenCalledTimes(1);
		stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
