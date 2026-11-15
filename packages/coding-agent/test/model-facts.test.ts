import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelFacts } from "../src/core/model-facts.ts";

const facts = { "gpt-7": { tool_call: true, reasoning: true } };
const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
const directories: string[] = [];

function cachePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "lunr-facts-"));
	directories.push(directory);
	return join(directory, "facts.json");
}

function publication(published: unknown, digestValue = digest) {
	return vi.fn(async (url: string | URL | Request) =>
		String(url).endsWith("publication.json")
			? Response.json({ revision: "sha256-abc", facts: digestValue })
			: Response.json(published),
	);
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model facts", () => {
	it("downloads facts once and reuses them while the digest holds", async () => {
		const path = cachePath();
		const fetchImpl = publication(facts);
		expect((await loadModelFacts({ allowNetwork: true, cachePath: path, fetchImpl }))?.find("gpt-7")).toMatchObject({
			reasoning: true,
		});
		await loadModelFacts({ allowNetwork: true, cachePath: path, fetchImpl });
		expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("facts.json"))).toHaveLength(1);
		expect((await loadModelFacts({ allowNetwork: false, cachePath: path }))?.find("gpt-7")).toBeDefined();
	});

	it("keeps the cached copy when a download fails its checksum", async () => {
		const path = cachePath();
		await loadModelFacts({ allowNetwork: true, cachePath: path, fetchImpl: publication(facts) });
		const tampered = await loadModelFacts({
			allowNetwork: true,
			cachePath: path,
			fetchImpl: publication({ "gpt-7": { reasoning: false } }, "different"),
		});
		expect(tampered?.find("gpt-7")).toMatchObject({ reasoning: true });
	});

	it("returns nothing without network or cache", async () => {
		expect(await loadModelFacts({ allowNetwork: false, cachePath: cachePath() })).toBeUndefined();
	});
});
