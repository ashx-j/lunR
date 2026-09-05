import type { Api, Model } from "../types.ts";

/** Dynamic routers may report negative price sentinels. Keep them usable without reporting negative/free costs. */
export function normalizeCatalogPricing<T extends Model<Api>>(model: T): T {
	const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (fields.every((field) => Number.isFinite(model.cost[field]) && model.cost[field] >= 0)) return model;
	const cost = { ...model.cost };
	for (const field of fields) cost[field] = Math.max(0, Number.isFinite(cost[field]) ? cost[field] : 0);
	return {
		...model,
		cost,
		catalog: {
			...model.catalog,
			source: "provider",
			supplied: (model.catalog?.supplied ?? []).filter((field) => field !== "cost"),
			pricing: "unknown",
		},
	};
}
