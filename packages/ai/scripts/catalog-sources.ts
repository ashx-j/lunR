import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogSourceStatus {
	url: string;
	status: "fresh" | "cached";
	fetchedAt: string;
	digest: string;
	error?: string;
}

function coverage(payload: any): Map<string, number> {
	if (Array.isArray(payload?.data)) return new Map([["models", payload.data.length]]);
	if (Array.isArray(payload?.models)) return new Map([["models", payload.models.length]]);
	return new Map(Object.entries(payload ?? {}).flatMap(([provider, value]: [string, any]) =>
		value?.models && typeof value.models === "object" ? [[provider, Object.keys(value.models).length] as const] : [],
	));
}

/** Quarantine suspicious partial responses without preventing independent sources from updating. */
function validateCoverage(previous: unknown, next: unknown): void {
	const counts = coverage(next);
	for (const [provider, count] of coverage(previous)) {
		if (count >= 10 && (counts.get(provider) ?? 0) < count * 0.75) {
			throw new Error(`Suspicious catalog shrink for ${provider}: ${count} -> ${counts.get(provider) ?? 0}`);
		}
	}
}

/** Independent public source fetches with schema checks, bounded retries and last-good fallback. */
export class CatalogSources {
	readonly statuses: CatalogSourceStatus[] = [];
	private readonly pending = new Map<string, Promise<Response>>();
	private readonly directory: string;
	private readonly fetchImpl: typeof fetch;
	constructor(directory: string, fetchImpl: typeof fetch = fetch) {
		this.directory = directory;
		this.fetchImpl = fetchImpl;
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
		let cached: { payload: unknown; fetchedAt: string } | undefined;
		try { cached = JSON.parse(readFileSync(file, "utf8")); } catch { /* First run. */ }
		let error: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
			try {
				const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				if (!validate(payload)) throw new Error("Unexpected source schema or empty catalog");
				if (cached && validate(cached.payload)) validateCoverage(cached.payload, payload);
				const fetchedAt = new Date().toISOString();
				mkdirSync(this.directory, { recursive: true });
				const temporary = `${file}.${process.pid}.tmp`;
				writeFileSync(temporary, JSON.stringify({ payload, fetchedAt }));
				renameSync(temporary, file);
				return this.result(url, payload, fetchedAt, "fresh");
			} catch (cause) { error = cause; }
		}
		if (cached && validate(cached.payload)) {
			return this.result(url, cached.payload, cached.fetchedAt, "cached", error instanceof Error ? error.message : "Source unavailable");
		}
		throw new Error(`Catalog source unavailable and no valid cache: ${url}`, { cause: error });
	}

	private result(url: string, payload: unknown, fetchedAt: string, status: "fresh" | "cached", error?: string): Response {
		const json = JSON.stringify(payload);
		this.statuses.push({ url, status, fetchedAt, digest: createHash("sha256").update(json).digest("hex"), ...(error ? { error } : {}) });
		if (status === "cached") console.warn(`Using last-good catalog source: ${url} (${fetchedAt})`);
		return new Response(json, { headers: { "content-type": "application/json" } });
	}
}
