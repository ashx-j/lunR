import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogSources } from "../../ai/scripts/catalog-sources.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("public catalog sources", () => {
	it("quarantines a partial provider response even when its schema is valid", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lunr-source-test-"));
		directories.push(directory);
		const original = {
			openai: { models: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`model-${i}`, {}])) },
		};
		await new CatalogSources(
			directory,
			vi.fn(async () => Response.json(original)),
		).fetch("https://example.test/models");
		const sources = new CatalogSources(
			directory,
			vi.fn(async () => Response.json({ openai: { models: { remaining: {} } } })),
		);
		expect(await (await sources.fetch("https://example.test/models")).json()).toEqual(original);
		expect(sources.statuses[0]).toMatchObject({
			status: "cached",
			error: expect.stringContaining("Suspicious catalog shrink"),
		});
	});

	it("reuses validated data through an outage while another source updates", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lunr-source-test-"));
		directories.push(directory);
		const valid = (value: any) => Array.isArray(value.data) && value.data.length > 0;
		await new CatalogSources(
			directory,
			vi.fn(async () => Response.json({ data: [{ id: "old" }] })),
		).fetch("https://example.test/one", valid);
		const fetch = vi.fn(async (url) =>
			String(url).endsWith("one")
				? Response.json({ error: "wrong schema" })
				: Response.json({ data: [{ id: "new" }] }),
		);
		const sources = new CatalogSources(directory, fetch);
		const responses = await Promise.all([
			sources.fetch("https://example.test/one", valid),
			sources.fetch("https://example.test/two", valid),
		]);
		expect(await responses[0].json()).toEqual({ data: [{ id: "old" }] });
		expect(await responses[1].json()).toEqual({ data: [{ id: "new" }] });
		expect(sources.statuses.map((entry) => entry.status).sort()).toEqual(["cached", "fresh"]);
	});

	it("refuses a malformed source when no last-good copy exists", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lunr-source-test-"));
		directories.push(directory);
		const sources = new CatalogSources(
			directory,
			vi.fn(async () => Response.json([])),
		);
		await expect(sources.fetch("https://example.test/one", () => false)).rejects.toThrow("no valid cache");
	});
});
