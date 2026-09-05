import { type Api, type Model, withOpenAiEffortMetadata, withXaiEffortMetadata } from "@earendil-works/pi-ai";
import { modelKey, type OfficialCatalogSource } from "./official-catalog.ts";

export type CatalogProviderRefreshStatus = "ok" | "timeout" | "error" | "skipped" | "static";

export function mergeCatalogLayers(args: {
	bakedIn: readonly Model<Api>[];
	live?: readonly Model<Api>[];
	user?: readonly Model<Api>[];
	official?: readonly Model<Api>[];
}): Model<Api>[] {
	const byId = new Map<string, Model<Api>>();
	for (const model of args.bakedIn) byId.set(model.id, model);
	for (const model of args.live ?? []) byId.set(model.id, model);
	for (const model of args.user ?? []) byId.set(model.id, model);
	for (const model of args.official ?? []) byId.set(model.id, model);

	const seen = new Set<string>();
	const result: Model<Api>[] = [];
	for (const baked of args.bakedIn) {
		const merged = byId.get(baked.id);
		if (!merged) continue;
		result.push(merged);
		seen.add(baked.id);
	}
	for (const model of [...(args.live ?? []), ...(args.user ?? []), ...(args.official ?? [])]) {
		if (seen.has(model.id)) continue;
		const winner = byId.get(model.id);
		if (!winner) continue;
		result.push(winner);
		seen.add(model.id);
	}
	const liveById = new Map((args.live ?? []).map((model) => [model.id, model]));
	const pricedIds = new Set(
		[...args.bakedIn, ...(args.official ?? []), ...(args.user ?? [])]
			.filter((model) => model.catalog?.pricing !== "unknown")
			.map((model) => model.id),
	);
	return result.map((model) => {
		let resolved = withXaiEffortMetadata(model);
		if (!model.catalog?.supplied.includes("thinkingLevelMap")) resolved = withOpenAiEffortMetadata(resolved);
		const live = liveById.get(model.id);
		if (!live?.catalog) return resolved;
		resolved = { ...resolved, catalog: { ...live.catalog } };
		// Only supplied fields may override curated metadata. Inferred defaults never win.
		for (const field of live.catalog.supplied) Object.assign(resolved, { [field]: live[field] });
		if (pricedIds.has(model.id) || live.catalog.supplied.includes("cost")) delete resolved.catalog!.pricing;
		return resolved;
	});
}

export class CatalogOverlaySource {
	private official = new Map<string, Model<Api>[]>();
	private user = new Map<string, Model<Api>[]>();
	private live = new Map<string, Model<Api>[]>();

	setOfficial(models: readonly Model<Api>[]): void {
		this.official = groupByProvider(models);
	}

	setUser(models: readonly Model<Api>[]): void {
		this.user = groupByProvider(models);
	}

	setLive(providerId: string, models: readonly Model<Api>[]): void {
		this.live.set(providerId, [...models]);
	}

	officialFor(providerId: string): Model<Api>[] {
		return this.official.get(providerId) ?? [];
	}

	userFor(providerId: string): Model<Api>[] {
		return this.user.get(providerId) ?? [];
	}

	liveFor(providerId: string): Model<Api>[] {
		return this.live.get(providerId) ?? [];
	}

	/** Codex's complete account catalog is authoritative for picker availability only. */
	isAvailable(model: Model<Api>): boolean {
		if (model.catalog?.hidden) return false;
		const live = this.liveFor(model.provider);
		return (
			model.provider !== "openai-codex" ||
			!live.length ||
			live.some((row) => row.id === model.id && !row.catalog?.hidden)
		);
	}
}

function groupByProvider(models: readonly Model<Api>[]): Map<string, Model<Api>[]> {
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	return byProvider;
}

export function withCatalogOverlay<T extends { id: string; getModels: () => readonly Model<Api>[] }>(
	provider: T,
	overlay: CatalogOverlaySource,
): T {
	const bakedIn = () => provider.getModels();
	return {
		...provider,
		getModels: () =>
			mergeCatalogLayers({
				bakedIn: bakedIn(),
				live: overlay.liveFor(provider.id),
				user: overlay.userFor(provider.id),
				official: overlay.officialFor(provider.id),
			}),
	};
}

export interface CatalogRefreshProviderSummary {
	id: string;
	status: CatalogProviderRefreshStatus;
	added?: number;
	total?: number;
	error?: string;
}

export interface CatalogRefreshSummaryInput {
	official?: { source: OfficialCatalogSource; modelCount: number; evictedUserRows: number };
	providers: readonly CatalogRefreshProviderSummary[];
	asked?: readonly string[];
	extraDefaults?: number;
	ollama?: string;
}

/** Build the /refresh toast. One hung provider must not become a global timeout line. */
export function formatCatalogRefreshSummary(input: CatalogRefreshSummaryInput): string {
	const parts: string[] = [];
	if (input.official?.source === "github") {
		const evicted =
			input.official.evictedUserRows > 0 ? `; replaced ${input.official.evictedUserRows} user-filled row` : "";
		const plural = input.official.evictedUserRows === 1 ? "" : input.official.evictedUserRows > 0 ? "s" : "";
		parts.push(`Official catalog updated (${input.official.modelCount} models)${evicted}${plural}.`);
	}

	const refreshed: string[] = [];
	const failed: string[] = [];
	for (const provider of input.providers) {
		if (provider.status === "ok") {
			const added = provider.added ?? 0;
			const total = provider.total ?? 0;
			refreshed.push(added > 0 ? `${provider.id} (+${added})` : `${provider.id} (${total})`);
		} else if (provider.status === "timeout") {
			failed.push(`${provider.id} timed out (cached)`);
		} else if (provider.status === "error") {
			failed.push(formatLiveProviderError(provider));
		}
	}

	if (refreshed.length > 0) {
		parts.push(`Refreshed ${refreshed.join(", ")}.`);
	} else if (input.providers.some((provider) => provider.status === "ok")) {
		parts.push("Refreshed model catalogs.");
	}

	if (failed.length > 0) {
		parts.push(`${failed.join("; ")}.`);
	}

	if (input.asked && input.asked.length > 0) {
		parts.push(`Asked for missing metadata on ${input.asked.join(", ")}.`);
	}
	if (input.extraDefaults && input.extraDefaults > 0) {
		parts.push(`+${input.extraDefaults} more using defaults.`);
	}
	if (input.ollama) parts.push(input.ollama);

	if (parts.length === 0) return "Model catalogs refreshed.";
	return parts.join(" ");
}

function formatLiveProviderError(provider: CatalogRefreshProviderSummary): string {
	if (
		provider.id === "xai" &&
		provider.error &&
		/invalid_grant|refresh token revoked/i.test(provider.error) &&
		!/timed out|aborted|cancelled|ECONN|ENOTFOUND|network/i.test(provider.error)
	) {
		return "xai login expired (run /login xai)";
	}
	return provider.error ? `${provider.id} failed (${provider.error})` : `${provider.id} failed`;
}

export function knownModelKeys(
	bakedIn: readonly Model<Api>[],
	official: Iterable<string>,
	user: Iterable<string>,
): Set<string> {
	const keys = new Set<string>(official);
	for (const key of user) keys.add(key);
	for (const model of bakedIn) keys.add(modelKey(model.provider, model.id));
	return keys;
}
