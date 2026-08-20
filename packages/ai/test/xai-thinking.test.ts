import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { parseXaiGrok4Minor, withXaiEffortMetadata } from "../src/xai-effort.ts";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "../../../catalog/providers/xai.json");

function loadXaiCatalog(): Record<string, Model<"openai-completions" | "openai-responses">> {
	return JSON.parse(readFileSync(catalogPath, "utf8")) as Record<
		string,
		Model<"openai-completions" | "openai-responses">
	>;
}

describe("parseXaiGrok4Minor", () => {
	it("parses grok-4.N ids", () => {
		expect(parseXaiGrok4Minor("grok-4.5")).toBe(5);
		expect(parseXaiGrok4Minor("grok-4.6")).toBe(6);
		expect(parseXaiGrok4Minor("grok-4.20-0309-reasoning")).toBe(20);
		expect(parseXaiGrok4Minor("grok-4.3")).toBe(3);
	});

	it("ignores non grok-4.N ids", () => {
		expect(parseXaiGrok4Minor("grok-build-0.1")).toBeUndefined();
		expect(parseXaiGrok4Minor("grok-4-fast-reasoning")).toBeUndefined();
		expect(parseXaiGrok4Minor("grok-3")).toBeUndefined();
	});
});

describe("withXaiEffortMetadata", () => {
	it("adds xhigh and reasoning effort on grok-4.6 completions rows that omitted them", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.6",
			provider: "xai",
			api: "openai-completions",
			compat: { supportsStore: false, supportsReasoningEffort: false },
		});
		expect(stamped.thinkingLevelMap).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
		expect(stamped.compat).toMatchObject({ supportsStore: false, supportsReasoningEffort: true });
	});

	it("does not add xhigh on grok-4.5", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.5",
			provider: "xai",
			api: "openai-responses",
			thinkingLevelMap: { off: null, minimal: null },
		});
		expect(stamped.thinkingLevelMap?.xhigh).toBeUndefined();
	});
});

describe("xAI thinking catalog", () => {
	it("keeps grok-4.5 without native xhigh", () => {
		const model = getModel("xai", "grok-4.5");
		expect(model).toBeDefined();
		expect(model?.thinkingLevelMap).toMatchObject({ off: null, minimal: null });
		expect(model?.thinkingLevelMap?.xhigh).toBeUndefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high"]);
	});

	it("stamps grok-4.5 and grok-4.6+ overlays on the official catalog shard", () => {
		const catalog = loadXaiCatalog();
		const ids = Object.keys(catalog);
		expect(ids).toContain("grok-4.5");
		expect(ids).toContain("grok-4.6");

		for (const [id, model] of Object.entries(catalog)) {
			const minor = parseXaiGrok4Minor(id);
			if (minor === 5) {
				expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null });
				expect(model.thinkingLevelMap?.xhigh).toBeUndefined();
				expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high"]);
			}
			if (minor !== undefined && minor >= 6) {
				expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null, xhigh: "xhigh" });
				expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh"]);
				if (model.api === "openai-completions") {
					expect(model.compat).toMatchObject({ supportsReasoningEffort: true });
				}
			}
		}
	});
});
