import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./perplexity.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
	return true;
}

/** One factory owns its in-memory results; persisted record formats and TTL stay shared. */
export function createResultStore() {
	const storedResults = new Map<string, StoredSearchData>();
	function storeResult(id: string, data: StoredSearchData): void {
		storedResults.set(id, data);
	}

	function getResult(id: string): StoredSearchData | null {
		return storedResults.get(id) ?? null;
	}

	function getAllResults(): StoredSearchData[] {
		return Array.from(storedResults.values());
	}

	function deleteResult(id: string): boolean {
		return storedResults.delete(id);
	}

	function clearResults(): void {
		storedResults.clear();
	}

	function restoreFromSession(ctx: ExtensionContext): void {
		storedResults.clear();
		const now = Date.now();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === "web-search-results"
			) {
				const data = entry.data;
				if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
					storedResults.set(data.id, data);
				}
			}
		}
	}

	return {
		storeResult,
		getResult,
		getAllResults,
		deleteResult,
		clearResults,
		restoreFromSession,
	};
}
