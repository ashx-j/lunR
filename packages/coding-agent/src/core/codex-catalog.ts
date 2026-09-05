import { parseCodexCatalog } from "@earendil-works/pi-ai/catalog/codex";
import type { LiveModelDiscovery } from "./live-catalog.ts";

export function discoverCodexModels(payload: unknown, baseUrl: string): LiveModelDiscovery[] {
	return parseCodexCatalog(payload, baseUrl).map((model) => ({
		model,
		supplied: {
			name: model.catalog!.supplied.includes("name"),
			contextWindow: model.catalog!.supplied.includes("contextWindow"),
			maxTokens: model.catalog!.supplied.includes("maxTokens"),
			input: model.catalog!.supplied.includes("input"),
			cost: false,
			reasoning: model.catalog!.supplied.includes("reasoning"),
		},
	}));
}
