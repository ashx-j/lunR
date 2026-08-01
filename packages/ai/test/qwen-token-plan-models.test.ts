import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

describe("Qwen Token Plan models", () => {
	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"includes the token-plan-only flagship on %s",
		(provider) => {
			expect(getModel(provider, "qwen3.8-max-preview")).toBeDefined();
		},
	);

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)("includes qwen3.7-plus on %s", (provider) => {
		expect(getModel(provider, "qwen3.7-plus")).toBeDefined();
	});

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"excludes image/video generation models from %s",
		(provider) => {
			const modelIds = getModels(provider).map((m) => m.id);
			expect(modelIds).not.toContain("wan2.7-image-pro");
			expect(modelIds).not.toContain("happyhorse-1.1-t2v");
			expect(modelIds).not.toContain("qwen-image-2.0");
		},
	);

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"marks all %s rows as zero-cost (Credits billing)",
		(provider) => {
			for (const m of getModels(provider)) {
				expect(m.cost.input).toBe(0);
				expect(m.cost.output).toBe(0);
			}
		},
	);

	it.each(["qwen-token-plan", "qwen-token-plan-cn"] as const)(
		"uses the qwen thinking format and max_tokens field on %s",
		(provider) => {
			const m = getModel(provider, "qwen3.7-plus") as any;
			expect(m.compat?.thinkingFormat).toBe("qwen");
			expect(m.compat?.maxTokensField).toBe("max_tokens");
		},
	);
});
