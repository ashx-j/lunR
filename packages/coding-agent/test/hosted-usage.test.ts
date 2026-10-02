import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recordHostedUsage } from "../src/core/hosted-usage.ts";

afterEach(() => vi.unstubAllEnvs());
it("records concurrent helper responses outside conversation history without content", async () => {
	const profile = await mkdtemp(join(tmpdir(), "lunr-usage-ledger-"));
	try {
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		vi.stubEnv("LUNR_HOSTED_USAGE", "0");
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "router",
			model: "auto",
			responseModel: "vendor/real",
			responseId: "response",
			timestamp: Date.now(),
			stopReason: "stop",
			content: [{ type: "text", text: "private summary" }],
			usage: {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
			},
		};
		await recordHostedUsage(message, "compaction");
		expect(await readdir(profile)).toEqual([]);
		vi.stubEnv("LUNR_HOSTED_USAGE", "1");
		await Promise.all([recordHostedUsage(message, "compaction"), recordHostedUsage(message, "branch-summary")]);
		const directory = join(profile, "sessions", "_helpers");
		const [file] = await readdir(directory);
		const text = await readFile(join(directory, file!), "utf8");
		expect(text).not.toContain("private summary");
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(2);
		expect(new Set(records.map((entry) => entry.id)).size).toBe(2);
		expect(records[0].message).toMatchObject({
			provider: "router",
			model: "auto",
			responseModel: "vendor/real",
			responseId: "response",
			usage: message.usage,
		});
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
});
