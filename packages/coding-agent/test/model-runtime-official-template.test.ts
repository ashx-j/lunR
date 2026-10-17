import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("official catalog rows without their own compat", () => {
	it("keep their own model's thinking settings, not the provider's first model's", async () => {
		const credentials = AuthStorage.inMemory();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-test" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		// Anthropic's first built-in model uses adaptive thinking; Haiku 4.5 rejects it with a 400.
		const haiku = runtime.getModel("anthropic", "claude-haiku-4-5-20251001");
		expect(haiku?.compat?.forceAdaptiveThinking).not.toBe(true);
		expect(haiku?.thinkingLevelMap?.off).not.toBeNull();
		// A model that does use adaptive thinking keeps it.
		expect(runtime.getModel("anthropic", "claude-sonnet-5")?.compat?.forceAdaptiveThinking).toBe(true);
	});
});
