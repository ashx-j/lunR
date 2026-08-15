import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SubscriptionManager } from "../src/core/subscriptions.ts";
import { readUserModels, writeUserModels } from "../src/core/user-models.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = join(tmpdir(), `lunr-catalog-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cachedOpenRouterModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function userRow(id: string, provider = "openrouter") {
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		provider,
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		source: "user" as const,
	};
}

async function leftoverStore(): Promise<InMemoryModelsStore> {
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write("openrouter", {
		models: [cachedOpenRouterModel("cached-only-openrouter-model")],
		checkedAt: Date.now(),
	});
	return modelsStore;
}

async function createRuntime(options: {
	stored?: boolean;
	modelsStore: InMemoryModelsStore;
	catalogDir?: string;
}): Promise<ModelRuntime> {
	const credentials = AuthStorage.inMemory(
		options.stored ? { openrouter: { type: "api_key", key: "stored-or-key" } } : {},
	);
	return ModelRuntime.create({
		credentials,
		modelsStore: options.modelsStore,
		modelsPath: null,
		authPath: options.catalogDir ? join(options.catalogDir, "auth.json") : undefined,
		subscriptions: SubscriptionManager.inMemory(credentials),
		allowModelNetwork: false,
	});
}

describe("ModelRuntime live catalog auth gate", () => {
	it("hides OpenRouter when only OPENROUTER_API_KEY and leftover store/user rows exist", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test");
		const dir = tempDir();
		writeUserModels({ version: 1, models: [userRow("user-only-openrouter-model")] }, join(dir, "user-models.json"));
		const modelsStore = await leftoverStore();
		const runtime = await createRuntime({ modelsStore, catalogDir: dir });

		expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "openrouter")).toEqual([]);
		expect(runtime.hasConfiguredAuth("openrouter")).toBe(false);
		expect(runtime.getModel("openrouter", "cached-only-openrouter-model")).toBeUndefined();
		expect(runtime.getModel("openrouter", "user-only-openrouter-model")).toBeUndefined();
		expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("test");
	});

	it("lists OpenRouter and applies store + user overlays when a stored api_key exists", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test");
		const dir = tempDir();
		writeUserModels({ version: 1, models: [userRow("user-only-openrouter-model")] }, join(dir, "user-models.json"));
		const modelsStore = await leftoverStore();
		const runtime = await createRuntime({ stored: true, modelsStore, catalogDir: dir });

		const available = runtime.getAvailableSnapshot().filter((model) => model.provider === "openrouter");
		expect(available.length).toBeGreaterThan(0);
		expect(runtime.hasConfiguredAuth("openrouter")).toBe(true);
		expect(runtime.getModel("openrouter", "cached-only-openrouter-model")).toBeDefined();
		expect(runtime.getModel("openrouter", "user-only-openrouter-model")).toBeDefined();
		expect(available.some((model) => model.id === "cached-only-openrouter-model")).toBe(true);
		expect(available.some((model) => model.id === "user-only-openrouter-model")).toBe(true);
	});

	it("lists OpenRouter when a runtime API-key override is set", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test");
		const modelsStore = await leftoverStore();
		const runtime = await createRuntime({ modelsStore });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "openrouter")).toBe(false);

		await runtime.setRuntimeApiKey("openrouter", "runtime-key");
		expect(runtime.hasConfiguredAuth("openrouter")).toBe(true);
		expect(runtime.getModel("openrouter", "cached-only-openrouter-model")).toBeDefined();
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "openrouter")).toBe(true);
	});

	it("logout deletes store + user rows and empties the snapshot for that provider", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test");
		const dir = tempDir();
		const userPath = join(dir, "user-models.json");
		writeUserModels(
			{ version: 1, models: [userRow("user-only-openrouter-model"), userRow("keep-me", "xai")] },
			userPath,
		);
		const modelsStore = await leftoverStore();
		const runtime = await createRuntime({ stored: true, modelsStore, catalogDir: dir });
		expect(runtime.getModel("openrouter", "cached-only-openrouter-model")).toBeDefined();
		expect(runtime.getModel("openrouter", "user-only-openrouter-model")).toBeDefined();

		await runtime.logout("openrouter");

		expect(await modelsStore.read("openrouter")).toBeUndefined();
		expect(readUserModels(userPath).models.map((model) => `${model.provider}/${model.id}`)).toEqual(["xai/keep-me"]);
		expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "openrouter")).toEqual([]);
		expect(runtime.hasConfiguredAuth("openrouter")).toBe(false);
		expect(runtime.getModel("openrouter", "cached-only-openrouter-model")).toBeUndefined();
		expect(runtime.getModel("openrouter", "user-only-openrouter-model")).toBeUndefined();
		expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("test");
	});
});

describe("ModelRuntime official shard fetch", () => {
	it("create() does not fetch; refresh fetches shards only for stored providers", async () => {
		const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const href = String(url);
			if (href.endsWith("/providers.json")) {
				return new Response(JSON.stringify(["xai", "openrouter", "openai"]), { status: 200 });
			}
			if (href.endsWith("/providers/xai.json")) {
				return new Response(
					JSON.stringify({
						"grok-4.7": {
							id: "grok-4.7",
							name: "Grok 4.7",
							api: "openai-completions",
							provider: "xai",
							baseUrl: "https://api.x.ai/v1",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 3, output: 9, cacheRead: 0.5, cacheWrite: 0 },
							contextWindow: 600000,
							maxTokens: 600000,
							compat: { thinkingFormat: "openrouter" },
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
				xai: { type: "api_key", key: "stored-xai" },
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		await runtime.refresh({ allowNetwork: true });
		const officialUrls = fetchImpl.mock.calls
			.map((call) => String(call[0]))
			.filter((href) => href.includes("/catalog/"));
		expect(officialUrls.some((href) => href.endsWith("/providers.json"))).toBe(true);
		expect(officialUrls.some((href) => href.endsWith("/providers/xai.json"))).toBe(true);
		expect(officialUrls.some((href) => href.includes("/providers/openrouter.json"))).toBe(false);
		expect(runtime.getModel("xai", "grok-4.7")?.compat).toEqual({ thinkingFormat: "openrouter" });
	});
});
