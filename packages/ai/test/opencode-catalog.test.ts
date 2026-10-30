import { describe, expect, it } from "vitest";
import {
	inferOpencodeApiFromModelId,
	opencodeBaseUrl,
	parseZenModelIds,
	resolveOpencodeApi,
} from "../src/catalog/opencode.ts";
import { OPENCODE_MODELS } from "../src/providers/opencode.models.ts";

describe("parseZenModelIds", () => {
	it("reads OpenAI { data: [{ id }] } lists", () => {
		expect(
			parseZenModelIds({
				object: "list",
				data: [{ id: "big-pickle" }, { id: " x-preview-f-free " }, { object: "model" }],
			}),
		).toEqual(new Set(["big-pickle", "x-preview-f-free"]));
	});

	it("reads a bare array of ids", () => {
		expect(parseZenModelIds(["hy3-free", { id: "mimo-v2.5-free" }])).toEqual(new Set(["hy3-free", "mimo-v2.5-free"]));
	});

	it("returns an empty set for junk", () => {
		expect(parseZenModelIds(null)).toEqual(new Set());
		expect(parseZenModelIds({})).toEqual(new Set());
	});
});

describe("resolveOpencodeApi", () => {
	it("uses models.dev npm when present", () => {
		expect(resolveOpencodeApi({ npm: "@ai-sdk/openai", modelId: "muse-spark-1.2-contributor-free" })).toBe(
			"openai-responses",
		);
		expect(resolveOpencodeApi({ npm: "@ai-sdk/anthropic", modelId: "claude-sonnet-5" })).toBe("anthropic-messages");
		expect(resolveOpencodeApi({ npm: "@ai-sdk/google", modelId: "gemini-3.7-flash" })).toBe("google-generative-ai");
		expect(resolveOpencodeApi({ npm: "@ai-sdk/openai-compatible", modelId: "big-pickle" })).toBe(
			"openai-completions",
		);
	});

	it("guesses from the model id when npm is missing", () => {
		expect(inferOpencodeApiFromModelId("muse-spark-1.2-contributor-free")).toBe("openai-responses");
		expect(inferOpencodeApiFromModelId("gpt-5.6-luna")).toBe("openai-responses");
		expect(inferOpencodeApiFromModelId("grok-4.6")).toBe("openai-responses");
		expect(inferOpencodeApiFromModelId("claude-opus-5")).toBe("anthropic-messages");
		expect(inferOpencodeApiFromModelId("qwen3.7-plus")).toBe("anthropic-messages");
		expect(inferOpencodeApiFromModelId("gemini-3.7-flash")).toBe("google-generative-ai");
		expect(inferOpencodeApiFromModelId("x-preview-f-free")).toBe("openai-completions");
		expect(inferOpencodeApiFromModelId("laguna-s-2.1-free")).toBe("openai-completions");
	});

	it("builds Anthropic vs completions base URLs", () => {
		expect(opencodeBaseUrl("https://opencode.ai/zen", "anthropic-messages")).toBe("https://opencode.ai/zen");
		expect(opencodeBaseUrl("https://opencode.ai/zen", "openai-completions")).toBe("https://opencode.ai/zen/v1");
		expect(opencodeBaseUrl("https://opencode.ai/zen/go", "openai-responses")).toBe("https://opencode.ai/zen/go/v1");
	});
});

describe("OpenCode catalog", () => {
	it("points every model at the endpoint for its protocol", () => {
		for (const model of Object.values(OPENCODE_MODELS)) {
			expect(model.baseUrl, model.id).toBe(opencodeBaseUrl("https://opencode.ai/zen", model.api));
		}
	});
});
