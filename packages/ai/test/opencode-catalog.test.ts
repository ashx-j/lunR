import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	inferOpencodeApiFromModelId,
	isZeroCost,
	opencodeBaseUrl,
	opencodeFreeModelApi,
	parseZenModelIds,
	resolveOpencodeApi,
	shouldIncludeOpencodeModel,
} from "../scripts/opencode-catalog.ts";
import { OPENCODE_MODELS } from "../src/providers/opencode.models.ts";
import type { Model } from "../src/types.ts";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "../../../catalog/providers/opencode.json");

function loadOpencodeCatalog(): Record<string, Model> {
	return JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, Model>;
}

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

describe("shouldIncludeOpencodeModel", () => {
	const liveIds = new Set(["big-pickle", "laguna-s-2.1-free", "deepseek-v4-flash-free"]);

	it("drops rows that cannot tool-call", () => {
		expect(shouldIncludeOpencodeModel("big-pickle", { toolCall: false, liveIds, deprecated: false })).toBe(false);
	});

	it("keeps deprecated models.dev rows that Zen still serves", () => {
		expect(shouldIncludeOpencodeModel("laguna-s-2.1-free", { toolCall: true, liveIds, deprecated: true })).toBe(true);
		expect(shouldIncludeOpencodeModel("deepseek-v4-flash-free", { toolCall: true, liveIds, deprecated: true })).toBe(
			true,
		);
	});

	it("drops models.dev rows that are not on the live list", () => {
		expect(shouldIncludeOpencodeModel("north-mini-code-free", { toolCall: true, liveIds, deprecated: false })).toBe(
			false,
		);
		expect(shouldIncludeOpencodeModel("north-mini-code-free", { toolCall: true, liveIds, deprecated: true })).toBe(
			false,
		);
	});

	it("falls back to skip-deprecated when the live list is missing", () => {
		expect(shouldIncludeOpencodeModel("x-preview-f-free", { toolCall: true, liveIds: null, deprecated: false })).toBe(
			true,
		);
		expect(shouldIncludeOpencodeModel("laguna-s-2.1-free", { toolCall: true, liveIds: null, deprecated: true })).toBe(
			false,
		);
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

describe("OpenCode Zen catalog", () => {
	it("maps $0 rows to completions except Muse Spark contributor-free", () => {
		const catalog = loadOpencodeCatalog();
		const sources: Array<[string, Record<string, Model>]> = [
			["baked-in", OPENCODE_MODELS as unknown as Record<string, Model>],
			["official shard", catalog],
		];
		for (const [label, models] of sources) {
			const zeroCost = Object.values(models).filter((model) => isZeroCost(model.cost));
			expect(zeroCost.length, `${label} should list at least one free Zen model`).toBeGreaterThan(0);
			for (const model of zeroCost) {
				expect(model.api, `${label} ${model.id}`).toBe(opencodeFreeModelApi(model.id));
			}
		}
	});

	it("keeps Muse Spark contributor-free on the Responses API when present", () => {
		const baked = OPENCODE_MODELS["muse-spark-1.2-contributor-free" as keyof typeof OPENCODE_MODELS] as
			| Model
			| undefined;
		const catalog = loadOpencodeCatalog()["muse-spark-1.2-contributor-free"];
		for (const model of [baked, catalog]) {
			if (!model) continue;
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://opencode.ai/zen/v1");
			expect(isZeroCost(model.cost)).toBe(true);
		}
	});
});
