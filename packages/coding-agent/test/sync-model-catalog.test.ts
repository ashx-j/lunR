import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "sync-model-catalog.mjs");

function writeTinyBundle(dir: string): void {
	mkdirSync(join(dir, "providers"), { recursive: true });
	const shard = {
		"grok-4.6": {
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	};
	writeFileSync(join(dir, "models.json"), `${JSON.stringify({ xai: shard })}\n`);
	writeFileSync(join(dir, "providers.json"), `${JSON.stringify(["xai"])}\n`);
	writeFileSync(join(dir, "providers", "xai.json"), `${JSON.stringify(shard)}\n`);
}

describe("sync-model-catalog", () => {
	it("publishes a checksummed immutable snapshot", () => {
		const directory = mkdtempSync(join(tmpdir(), "lunr-versioned-catalog-"));
		try {
			const input = join(directory, "input");
			const providers: Record<string, Record<string, unknown>> = {};
			mkdirSync(join(input, "providers"), { recursive: true });
			for (const provider of ["anthropic", "openai", "openai-codex", "openrouter"]) {
				providers[provider] = {};
				for (let i = 0; i < 130; i++)
					providers[provider][`future-${i}`] = {
						id: `future-${i}`,
						provider,
						name: `Future ${i}`,
						api: "openai-completions",
						baseUrl: "https://example.test",
						contextWindow: 1000,
						maxTokens: 100,
						input: ["text"],
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					};
				writeFileSync(join(input, "providers", `${provider}.json`), JSON.stringify(providers[provider]));
			}
			writeFileSync(join(input, "models.json"), JSON.stringify(providers));
			writeFileSync(join(input, "providers.json"), JSON.stringify(Object.keys(providers)));
			const output = join(directory, "published");
			const result = spawnSync(
				process.execPath,
				[script, "--input", input, "--output", output, "--versioned", "--source-commit", "test"],
				{ encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			const manifest = JSON.parse(readFileSync(join(output, "publication.json"), "utf8"));
			const shard = JSON.parse(
				readFileSync(join(output, "snapshots", manifest.revision, "providers", "openai-codex.json"), "utf8"),
			);
			expect(manifest.shards["openai-codex"]).toBe(createHash("sha256").update(JSON.stringify(shard)).digest("hex"));
			expect(Object.keys(shard)).toHaveLength(130);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("rejects a tiny invalid bundle", () => {
		const dir = join(tmpdir(), `lunr-sync-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		writeTinyBundle(dir);
		const result = spawnSync(process.execPath, [script, "--check", "--input", dir], {
			encoding: "utf8",
			cwd: repoRoot,
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/Required provider is missing|Refusing to publish only/i);
	});
});
