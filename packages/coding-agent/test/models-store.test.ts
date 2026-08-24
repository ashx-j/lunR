import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FileModelsStore } from "../src/core/models-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true });
	}
});

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("FileModelsStore", () => {
	it("persists provider catalogs without replacing unrelated providers", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "models-store.json");
		const store = new FileModelsStore(path);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });

		const reloaded = new FileModelsStore(path);
		expect((await reloaded.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
		expect((await reloaded.read("one"))?.checkedAt).toBe(100);
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);

		await reloaded.delete("one");
		expect(await reloaded.read("one")).toBeUndefined();
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it("treats empty, truncated, and NUL-filled store files as empty instead of throwing", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });

		const emptyPath = join(dir, "empty.json");
		writeFileSync(emptyPath, "");
		expect(await new FileModelsStore(emptyPath).read("one")).toBeUndefined();

		const truncatedPath = join(dir, "truncated.json");
		writeFileSync(truncatedPath, '{"one":{"models":[');
		expect(await new FileModelsStore(truncatedPath).read("one")).toBeUndefined();

		const nulPath = join(dir, "nul.json");
		writeFileSync(nulPath, Buffer.alloc(64, 0));
		const store = new FileModelsStore(nulPath);
		expect(await store.read("one")).toBeUndefined();

		await store.write("one", { models: [model("one", "m1")], checkedAt: 1 });
		expect((await store.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
	});
});
