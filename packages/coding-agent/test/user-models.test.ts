import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	evictUserModelsByProvider,
	evictUserModelsOnOfficial,
	readUserModels,
	UserModelsStore,
	upsertUserModels,
	writeUserModels,
} from "../src/core/user-models.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = join(tmpdir(), `lunr-user-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function userRow(id: string, provider = "xai") {
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		source: "user" as const,
	};
}

describe("user-models", () => {
	it("writes and reads user-models.json", () => {
		const path = join(tempDir(), "user-models.json");
		writeUserModels({ version: 1, models: [userRow("grok-4.6"), userRow("keep-me")] }, path);
		const loaded = readUserModels(path);
		expect(loaded.models.map((model) => model.id)).toEqual(["grok-4.6", "keep-me"]);
		expect(loaded.models[0]?.source).toBe("user");
	});

	it("returns an empty document when the file is missing", () => {
		expect(readUserModels(join(tempDir(), "missing.json")).models).toEqual([]);
	});

	it("evicts an official id and keeps other user rows", () => {
		const { next, evicted } = evictUserModelsOnOfficial(
			{ version: 1, models: [userRow("grok-4.6"), userRow("keep-me"), userRow("other", "openrouter")] },
			["xai/grok-4.6"],
		);
		expect(evicted.map((model) => `${model.provider}/${model.id}`)).toEqual(["xai/grok-4.6"]);
		expect(next.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["xai/keep-me", "openrouter/other"]);
	});

	it("upserts by provider/id without dropping siblings", () => {
		const next = upsertUserModels({ version: 1, models: [userRow("keep-me")] }, [
			{ ...userRow("grok-new"), contextWindow: 200000 },
		]);
		expect(next.models).toHaveLength(2);
		expect(next.models.find((model) => model.id === "grok-new")?.contextWindow).toBe(200000);
	});

	it("evicts every row for a provider and keeps siblings", () => {
		const { next, evicted } = evictUserModelsByProvider(
			{ version: 1, models: [userRow("a", "openrouter"), userRow("b", "openrouter"), userRow("c")] },
			"openrouter",
		);
		expect(evicted.map((model) => `${model.provider}/${model.id}`)).toEqual(["openrouter/a", "openrouter/b"]);
		expect(next.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["xai/c"]);
	});

	it("UserModelsStore.evictProvider persists the remaining rows", () => {
		const path = join(tempDir(), "user-models.json");
		writeUserModels({ version: 1, models: [userRow("gone", "openrouter"), userRow("stay")] }, path);
		const store = new UserModelsStore(path);
		expect(store.evictProvider("openrouter").map((model) => model.id)).toEqual(["gone"]);
		expect(readUserModels(path).models.map((model) => model.id)).toEqual(["stay"]);
	});
});
