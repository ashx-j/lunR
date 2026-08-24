import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import {
	parseXaiGrok4Minor,
	shouldUseXaiResponsesApi,
	withXaiEffortMetadata,
	XAI_RESPONSES_COMPAT,
	XAI_RESPONSES_EXCLUDED_MODEL_IDS,
} from "../src/xai-effort.ts";

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

describe("shouldUseXaiResponsesApi", () => {
	it("is a version floor, not a frozen grok-4.5 id", () => {
		expect(shouldUseXaiResponsesApi("grok-4.3")).toBe(false);
		expect(shouldUseXaiResponsesApi("grok-4.5")).toBe(true);
		expect(shouldUseXaiResponsesApi("grok-4.6")).toBe(true);
		expect(shouldUseXaiResponsesApi("grok-4.7")).toBe(true);
		expect(shouldUseXaiResponsesApi("grok-build-0.1")).toBe(false);
	});

	it("honors named Completions exceptions", () => {
		XAI_RESPONSES_EXCLUDED_MODEL_IDS.add("grok-4.6");
		try {
			expect(shouldUseXaiResponsesApi("grok-4.6")).toBe(false);
			expect(shouldUseXaiResponsesApi("grok-4.5")).toBe(true);
		} finally {
			XAI_RESPONSES_EXCLUDED_MODEL_IDS.delete("grok-4.6");
		}
	});
});

describe("withXaiEffortMetadata", () => {
	it("promotes grok-4.6 completions rows to Responses without leaking Completions compat", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.6",
			provider: "xai",
			api: "openai-completions",
			compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
		});
		expect(stamped.api).toBe("openai-responses");
		expect(stamped.thinkingLevelMap).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
		expect(stamped.compat).toEqual({ ...XAI_RESPONSES_COMPAT });
		expect(stamped.compat).not.toHaveProperty("supportsDeveloperRole");
		expect(stamped.compat).not.toHaveProperty("supportsReasoningEffort");
	});

	it("promotes grok-4.5 completions rows to Responses", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.5",
			provider: "xai",
			api: "openai-completions",
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
		expect(stamped.api).toBe("openai-responses");
		expect(stamped.thinkingLevelMap).toEqual({ off: null, minimal: null });
		expect(stamped.compat).toEqual({ ...XAI_RESPONSES_COMPAT });
	});

	it("does not add xhigh on grok-4.5", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.5",
			provider: "xai",
			api: "openai-responses",
			thinkingLevelMap: { off: null, minimal: null },
		});
		expect(stamped.api).toBe("openai-responses");
		expect(stamped.thinkingLevelMap?.xhigh).toBeUndefined();
		expect(stamped.compat).toMatchObject({ supportsLongCacheRetention: false });
	});

	it("leaves grok-4.3 on Completions", () => {
		const stamped = withXaiEffortMetadata({
			id: "grok-4.3",
			provider: "xai",
			api: "openai-completions",
			compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
		});
		expect(stamped.api).toBe("openai-completions");
		expect(stamped.compat).toMatchObject({ supportsDeveloperRole: false, supportsReasoningEffort: false });
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
		expect(catalog["grok-4.6"].api).toBe("openai-responses");

		for (const [id, model] of Object.entries(catalog)) {
			const stamped = withXaiEffortMetadata(model);
			const minor = parseXaiGrok4Minor(id);
			if (shouldUseXaiResponsesApi(id)) {
				expect(stamped.api).toBe("openai-responses");
				expect(stamped.compat).toMatchObject({ supportsLongCacheRetention: false });
				expect(stamped.compat).not.toHaveProperty("supportsDeveloperRole");
			} else if (minor !== undefined) {
				expect(stamped.api).toBe("openai-completions");
			}
			if (minor === 5) {
				expect(stamped.thinkingLevelMap).toMatchObject({ off: null, minimal: null });
				expect(stamped.thinkingLevelMap?.xhigh).toBeUndefined();
				expect(getSupportedThinkingLevels(stamped)).toEqual(["low", "medium", "high"]);
			}
			if (minor !== undefined && minor >= 6) {
				expect(stamped.thinkingLevelMap).toMatchObject({ off: null, minimal: null, xhigh: "xhigh" });
				expect(getSupportedThinkingLevels(stamped)).toEqual(["low", "medium", "high", "xhigh"]);
			}
		}
	});
});
