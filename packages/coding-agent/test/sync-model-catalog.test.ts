import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
