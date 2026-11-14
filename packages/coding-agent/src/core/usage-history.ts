import { type AccountedRequest, collectUsageRequests, usageTokens } from "./usage-accounting.ts";
/**
 * Request usage history for integrations.
 *
 * Scans the on-disk session files (`.jsonl` under `getSessionsDir()`, both the
 * flat and the per-project-subdirectory layouts) and aggregates:
 * - Token totals per provider/model from conversation and auxiliary-request `usage`
 *   metadata (same fields the live session rows use),
 * - per-day totals (YYYY-MM-DD buckets from the entry timestamp),
 * - an ESTIMATED category breakdown (chars/4) via the same accounting as
 *   `computeContextBreakdown` — session files don't store the system prompt or
 *   tool definitions, so `includesSystemPrompt` is always false and the
 *   message categories carry the whole breakdown.
 *
 * Results are cached per file keyed on mtime+size; unchanged files are not
 * re-parsed. Never throws — corrupt files are skipped, total failure returns
 * an empty aggregate.
 */

import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "../config.ts";
import { computeContextBreakdown } from "./context-breakdown.ts";
import { loadEntriesFromFile, type SessionEntry, sessionEntryToContextMessages } from "./session-manager.ts";

export interface UsageHistoryModelRow {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageHistoryDayRow {
	/** YYYY-MM-DD (UTC). */
	day: string;
	total: number;
}

export interface UsageHistoryCategories {
	user: number;
	assistantText: number;
	thinking: number;
	toolCalls: number;
	toolResults: number;
	summaries: number;
	total: number;
}

export interface UsageHistory {
	perModel: UsageHistoryModelRow[];
	perDay: UsageHistoryDayRow[];
	categories: UsageHistoryCategories;
	/** False: session files don't store the system prompt / tool definitions. */
	includesSystemPrompt: boolean;
	/** Session files inside the scan window (mtime ≥ sinceMs). */
	filesScanned: number;
	/** Files actually parsed this call (cache misses). Also serves as a test hook. */
	filesParsed: number;
	/** Scanned files containing at least one assistant message with usage. */
	sessionsWithUsage: number;
}

interface FileAggregate {
	mtimeMs: number;
	size: number;
	requests: AccountedRequest[];
	entries: SessionEntry[];
}

const fileCache = new Map<string, FileAggregate>();

/** Test hook: drop all cached per-file aggregates. */
export function resetUsageHistoryCache(): void {
	fileCache.clear();
}

function emptyCategories(): UsageHistoryCategories {
	return { user: 0, assistantText: 0, thinking: 0, toolCalls: 0, toolResults: 0, summaries: 0, total: 0 };
}

function emptyHistory(): UsageHistory {
	return {
		perModel: [],
		perDay: [],
		categories: emptyCategories(),
		includesSystemPrompt: false,
		filesScanned: 0,
		filesParsed: 0,
		sessionsWithUsage: 0,
	};
}

/** Enumerate `.jsonl` session files in both layouts: flat and per-project subdirectories. */
function enumerateSessionFiles(sessionsDir: string): string[] {
	const files: string[] = [];
	let dirEntries: Dirent[];
	try {
		dirEntries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of dirEntries) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(join(sessionsDir, entry.name));
		} else if (entry.isDirectory()) {
			try {
				const subDir = join(sessionsDir, entry.name);
				for (const name of readdirSync(subDir)) {
					if (name.endsWith(".jsonl")) files.push(join(subDir, name));
				}
			} catch {
				// Unreadable subdirectory — skip.
			}
		}
	}
	return files;
}

/** Cache parsed records, not date-window aggregates, so changing the window stays correct. */
function parseSessionFile(filePath: string, mtimeMs: number, size: number): FileAggregate | null {
	try {
		const entries = loadEntriesFromFile(filePath).filter((entry): entry is SessionEntry => entry.type !== "session");
		return { mtimeMs, size, entries, requests: collectUsageRequests(entries) };
	} catch {
		return null;
	}
}

/**
 * Aggregate requests since `sinceMs`; file modification time only narrows the scan.
 * Never throws; on total failure returns an empty aggregate.
 */
export function collectUsageHistory(options: { sinceMs: number; sessionsDir?: string }): UsageHistory {
	const result = emptyHistory();
	try {
		const sessionsDir = options.sessionsDir ?? getSessionsDir();
		const files = enumerateSessionFiles(sessionsDir);
		const seen = new Set<string>();
		const seenRequests = new Set<string>();
		const seenEntries = new Set<string>();

		for (const filePath of files) {
			seen.add(filePath);
			let stats: Stats;
			try {
				stats = statSync(filePath);
			} catch {
				continue; // vanished between readdir and stat
			}
			if (stats.mtimeMs < options.sinceMs) continue;
			result.filesScanned++;

			let aggregate = fileCache.get(filePath);
			if (!aggregate || aggregate.mtimeMs !== stats.mtimeMs || aggregate.size !== stats.size) {
				aggregate = parseSessionFile(filePath, stats.mtimeMs, stats.size) ?? undefined;
				result.filesParsed++;
				if (aggregate) {
					fileCache.set(filePath, aggregate);
				} else {
					fileCache.delete(filePath);
				}
			}
			if (!aggregate) continue;

			let hasUsage = false;
			for (const request of aggregate.requests) {
				if (request.timestamp < options.sinceMs || seenRequests.has(request.id)) continue;
				seenRequests.add(request.id);
				hasUsage = true;
				const model = `${request.provider}/${request.model}`;
				let row = result.perModel.find((candidate) => candidate.model === model);
				if (!row) {
					row = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					result.perModel.push(row);
				}
				row.input += request.usage.input;
				row.output += request.usage.output;
				row.cacheRead += request.usage.cacheRead;
				row.cacheWrite += request.usage.cacheWrite;
				row.total += usageTokens(request.usage);
				const day = new Date(request.timestamp).toISOString().slice(0, 10);
				const dayRow = result.perDay.find((candidate) => candidate.day === day);
				if (dayRow) dayRow.total += usageTokens(request.usage);
				else result.perDay.push({ day, total: usageTokens(request.usage) });
			}
			if (hasUsage) result.sessionsWithUsage++;
			const messages = aggregate.entries
				.filter((entry) => {
					const identity = `${entry.id}:${entry.timestamp}`;
					if (entry.inherited || Date.parse(entry.timestamp) < options.sinceMs || seenEntries.has(identity))
						return false;
					seenEntries.add(identity);
					return true;
				})
				.flatMap(sessionEntryToContextMessages);
			const breakdown = computeContextBreakdown({ systemPrompt: "", tools: [], messages, contextWindow: 0 });
			for (const key of Object.keys(result.categories) as Array<keyof UsageHistoryCategories>)
				result.categories[key] += breakdown[key];
		}

		// Drop cache entries for deleted files.
		for (const cachedPath of fileCache.keys()) {
			if (!seen.has(cachedPath)) fileCache.delete(cachedPath);
		}

		result.perModel.sort((a, b) => b.total - a.total);
		result.perDay.sort((a, b) => a.day.localeCompare(b.day));
	} catch {
		return emptyHistory();
	}
	return result;
}
