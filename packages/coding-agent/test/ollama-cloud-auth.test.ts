import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelIds, resolveOllamaApiKey } from "../src/builtin-extensions/pi-ollama-cloud/models.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOllamaKey = process.env.OLLAMA_API_KEY;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalOllamaKey === undefined) delete process.env.OLLAMA_API_KEY;
	else process.env.OLLAMA_API_KEY = originalOllamaKey;
});

describe("resolveOllamaApiKey", () => {
	it("uses the stored auth.json api_key when OLLAMA_API_KEY is unset", () => {
		const dir = join(tmpdir(), `lunr-ollama-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ "ollama-cloud": { type: "api_key", key: "stored-ollama-key" } }),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.OLLAMA_API_KEY;
		try {
			expect(resolveOllamaApiKey()).toBe("stored-ollama-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sends Authorization from the stored key when fetching the model list", async () => {
		const dir = join(tmpdir(), `lunr-ollama-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ "ollama-cloud": { type: "api_key", key: "stored-ollama-key" } }),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.OLLAMA_API_KEY;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "llama" }] }), { status: 200 }));
		try {
			await fetchModelIds(50);
			expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer stored-ollama-key" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers the environment key over auth.json", () => {
		const dir = join(tmpdir(), `lunr-ollama-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ "ollama-cloud": { type: "api_key", key: "stored-ollama-key" } }),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.OLLAMA_API_KEY = "env-ollama-key";
		try {
			expect(resolveOllamaApiKey()).toBe("env-ollama-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
