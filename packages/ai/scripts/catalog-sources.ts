import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogSourceStatus {
	url: string;
	status: "fresh" | "cached";
	fetchedAt: string;
	digest: string;
	error?: string;
	/** Providers kept at their last-good copy because they shrank suspiciously. */
	quarantined?: string[];
}

type ProviderKeyed = Record<string, { models?: Record<string, unknown> }>;

/** A models.dev-shaped payload: providers keyed by id, each with a models object. */
function isProviderKeyed(payload: unknown): payload is ProviderKeyed {
	return (
		!!payload &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		!Array.isArray((payload as { data?: unknown }).data) &&
		!Array.isArray((payload as { models?: unknown }).models)
	);
}

function coverage(payload: any): Map<string, number> {
	if (Array.isArray(payload?.data)) return new Map([["models", payload.data.length]]);
	if (Array.isArray(payload?.models)) return new Map([["models", payload.models.length]]);
	return new Map(Object.entries(payload ?? {}).flatMap(([provider, value]: [string, any]) =>
		value?.models && typeof value.models === "object" ? [[provider, Object.keys(value.models).length] as const] : [],
	));
}

/** True when a count fell by more than a quarter from at least ten. */
const suspicious = (before: number, after: number) => before >= 10 && after < before * 0.75;

/**
 * Quarantine suspicious partial responses. A provider in a keyed catalog that shrank keeps its
 * last-good copy while the others update, because one provider models.dev trims must not freeze
 * every other provider's new models. A provider that disappears entirely is a removal or a rename
 * and is let go. A flat model list, or a keyed catalog whose total shrank, falls back as a whole.
 */
function guardCoverage(previous: unknown, next: unknown): { payload: unknown; quarantined: string[] } {
	const before = coverage(previous);
	const after = coverage(next);
	const total = (counts: Map<string, number>) => [...counts.values()].reduce((sum, count) => sum + count, 0);
	if (!isProviderKeyed(next) || !isProviderKeyed(previous) || suspicious(total(before), total(after))) {
		const shrunk = [...before].filter(([key, count]) => suspicious(count, after.get(key) ?? 0)).map(([key]) => key);
		if (shrunk.length || suspicious(total(before), total(after))) {
			throw new Error(`Suspicious catalog shrink for ${shrunk.join(", ") || "the whole source"}`);
		}
		return { payload: next, quarantined: [] };
	}
	const quarantined = [...before]
		.filter(([key, count]) => after.has(key) && suspicious(count, after.get(key) ?? 0))
		.map(([key]) => key);
	return {
		payload: { ...next, ...Object.fromEntries(quarantined.map((key) => [key, previous[key]])) },
		quarantined,
	};
}

/** Independent public source fetches with schema checks, bounded retries and last-good fallback. */
export class CatalogSources {
	readonly statuses: CatalogSourceStatus[] = [];
	private readonly pending = new Map<string, Promise<Response>>();
	private readonly directory: string;
	private readonly fetchImpl: typeof fetch;
	private readonly offline: boolean;
	/** `offline` reads only the last-good copies, so a rerun sees exactly the same inputs. */
	constructor(directory: string, fetchImpl: typeof fetch = fetch, options: { offline?: boolean } = {}) {
		this.directory = directory;
		this.fetchImpl = fetchImpl;
		this.offline = options.offline === true;
	}

	fetch(url: string, validate: (value: any) => boolean = (value) => !!value && typeof value === "object"): Promise<Response> {
		let pending = this.pending.get(url);
		if (!pending) {
			pending = this.load(url, validate);
			this.pending.set(url, pending);
		}
		return pending.then((response) => response.clone());
	}

	private async load(url: string, validate: (value: any) => boolean): Promise<Response> {
		const file = join(this.directory, `${createHash("sha256").update(url).digest("hex")}.json`);
		let cached: { payload: unknown; fetchedAt: string; quarantined?: string[] } | undefined;
		try { cached = JSON.parse(readFileSync(file, "utf8")); } catch { /* First run. */ }
		let error: unknown = this.offline ? new Error("Offline") : undefined;
		for (let attempt = 0; attempt < (this.offline ? 0 : 3); attempt++) {
			if (attempt) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
			try {
				const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				let payload = await response.json();
				if (!validate(payload)) throw new Error("Unexpected source schema or empty catalog");
				let quarantined: string[] = [];
				if (cached && validate(cached.payload)) ({ payload, quarantined } = guardCoverage(cached.payload, payload));
				const fetchedAt = new Date().toISOString();
				mkdirSync(this.directory, { recursive: true });
				const temporary = `${file}.${process.pid}.tmp`;
				writeFileSync(temporary, JSON.stringify({ payload, fetchedAt, ...(quarantined.length ? { quarantined } : {}) }));
				renameSync(temporary, file);
				if (quarantined.length) console.warn(`Keeping last-good ${quarantined.join(", ")} from ${url}: suspicious shrink`);
				return this.result(url, payload, fetchedAt, "fresh", undefined, quarantined);
			} catch (cause) { error = cause; }
		}
		if (cached && validate(cached.payload)) {
			return this.result(
				url,
				cached.payload,
				cached.fetchedAt,
				"cached",
				error instanceof Error ? error.message : "Source unavailable",
				cached.quarantined,
			);
		}
		throw new Error(`Catalog source unavailable and no valid cache: ${url}`, { cause: error });
	}

	private result(
		url: string,
		payload: unknown,
		fetchedAt: string,
		status: "fresh" | "cached",
		error?: string,
		quarantined: string[] = [],
	): Response {
		const json = JSON.stringify(payload);
		this.statuses.push({
			url,
			status,
			fetchedAt,
			digest: createHash("sha256").update(json).digest("hex"),
			...(error ? { error } : {}),
			...(quarantined.length ? { quarantined } : {}),
		});
		if (status === "cached") console.warn(`Using last-good catalog source: ${url} (${fetchedAt})`);
		return new Response(json, { headers: { "content-type": "application/json" } });
	}
}
