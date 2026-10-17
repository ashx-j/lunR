import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("Claude subscription model lookups", () => {
	it("return the window Claude Code reported at setup, not the catalog's", async () => {
		const credentials = AuthStorage.inMemory();
		await credentials.modify("anthropic", async () => ({
			type: "external_claude_code",
			version: 3,
			manager: "claude-code",
			command: "/opt/claude",
			accountFingerprint: "test-account",
			models: [
				{ id: "claude-sonnet-5", route: "claude-sonnet-5[1m]", contextWindow: 1_000_000 },
				{ id: "claude-opus-5", route: "claude-opus-5", contextWindow: 200_000 },
			],
		}));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		// A saved default or restored session looks the model up by id, so it must get the same 200K
		// window as /model, or compaction would wait for 1M while Claude Code stops at 200K.
		expect(runtime.getModel("anthropic", "claude-opus-5")?.contextWindow).toBe(200_000);
		expect(runtime.getModel("anthropic", "claude-sonnet-5")?.contextWindow).toBe(1_000_000);
	});
});
