import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const bridge = pathToFileURL(join(import.meta.dirname, "../src/api/anthropic-claude-code-bridge.ts")).href;
const models = pathToFileURL(join(import.meta.dirname, "../src/providers/anthropic.models.ts")).href;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
	"removes the request directory when lunR exits during a Claude Code request",
	() => {
		const root = mkdtempSync(join(tmpdir(), "lunr-bridge-exit-"));
		roots.push(root);
		const temp = join(root, "tmp");
		const command = join(root, "claude");
		// Reads the request, records its pid and never answers, like a Claude Code on a slow upstream.
		writeFileSync(
			command,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
		);
		chmodSync(command, 0o755);
		mkdirSync(temp);
		const script = `
			import { existsSync, readFileSync, readdirSync } from "node:fs";
			const { streamClaudeCode } = await import(${JSON.stringify(bridge)});
			const connection = { type: "external_claude_code", version: 3, manager: "claude-code", command: ${JSON.stringify(command)},
				models: [{ id: "claude-opus-4-8", route: "claude-opus-4-8[1m]", contextWindow: 1000000 }] };
			const { ANTHROPIC_MODELS } = await import(${JSON.stringify(models)});
			const model = ANTHROPIC_MODELS["claude-opus-4-8"];
			void streamClaudeCode(model, { systemPrompt: "x", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{ externalClaudeCode: connection }, true, "http://127.0.0.1:9").result();
			const pidFile = ${JSON.stringify(join(root, "pid"))};
			while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
			console.log(readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("lunr-claude-code-")).length);
			process.kill(Number(readFileSync(pidFile, "utf8")));
			process.exit(0);
		`;
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			env: { ...process.env, TMPDIR: temp },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("1");
		expect(readdirSync(temp).filter((name) => name.startsWith("lunr-claude-code-"))).toEqual([]);
	},
	30_000,
);
