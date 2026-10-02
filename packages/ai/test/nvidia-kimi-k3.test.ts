import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

const modelId = "moonshotai/kimi-k3";

describe("NVIDIA Kimi K3", () => {
	it("is available from the built-in catalog with NVIDIA trial endpoint limits", () => {
		const model = getModel("nvidia", modelId);
		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: modelId,
			provider: "nvidia",
			api: "openai-completions",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
			compat: {
				supportsReasoningEffort: true,
				requiresReasoningContentOnAssistantMessages: true,
			},
		});
		if (!model) return;
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high", "max"]);
	});
});
