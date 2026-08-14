/**
 * lunr: 30-day token usage history for the /usage command.
 *
 * Scans the on-disk session files (`.jsonl` under `getSessionsDir()`, both the
 * flat and the per-project-subdirectory layouts) and aggregates:
 * - REAL token totals per provider/model from assistant-message `usage`
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
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getSessionsDir } from "../config.ts";
import { computeContextBreakdown } from "./context-breakdown.ts";
import {
	type FileEntry,
	loadEntriesFromFile,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "./session-manager.ts";

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
	perModel: Map<string, UsageHistoryModelRow>;
	perDay: Map<string, number>;
	categories: UsageHistoryCategories;
	hasUsage: boolean;
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

/** Milliseconds for day bucketing: entry timestamp, then message timestamp, then file mtime. */
function entryTimestampMs(entry: SessionEntry, message: AssistantMessage, fallbackMs: number): number {
	const entryMs = Date.parse(entry.timestamp ?? "");
	if (!Number.isNaN(entryMs)) return entryMs;
	if (typeof message.timestamp === "number" && message.timestamp > 0) return message.timestamp;
	return fallbackMs;
}

/** Parse one session file into its aggregate. Returns null when the file is unusable. */
function parseSessionFile(filePath: string, mtimeMs: number, size: number): FileAggregate | null {
	let entries: FileEntry[];
	try {
		entries = loadEntriesFromFile(filePath);
	} catch {
		return null;
	}
	if (entries.length === 0) return null;

	const aggregate: FileAggregate = {
		mtimeMs,
		size,
		perModel: new Map(),
		perDay: new Map(),
		categories: emptyCategories(),
		hasUsage: false,
	};

	const sessionEntries: SessionEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "session") continue; // header
		sessionEntries.push(entry);

		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") continue;

		const provider = typeof message.provider === "string" && message.provider ? message.provider : "unknown";
		const modelId = message.responseModel ?? message.model;
		const key = `${provider}/${typeof modelId === "string" && modelId ? modelId : "unknown"}`;
		const input = usage.input;
		const output = usage.output;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;

		let row = aggregate.perModel.get(key);
		if (!row) {
			row = { model: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			aggregate.perModel.set(key, row);
		}
		row.input += input;
		row.output += output;
		row.cacheRead += cacheRead;
		row.cacheWrite += cacheWrite;
		row.total += input + output + cacheRead + cacheWrite;
		aggregate.hasUsage = true;

		const day = new Date(entryTimestampMs(entry, message, mtimeMs)).toISOString().slice(0, 10);
		aggregate.perDay.set(day, (aggregate.perDay.get(day) ?? 0) + input + output + cacheRead + cacheWrite);
	}

	// Category estimate over the file's messages (system prompt/tools are not
	// stored in session files, so message categories carry the breakdown).
	try {
		const messages = sessionEntries.flatMap(sessionEntryToContextMessages);
		const breakdown = computeContextBreakdown({ systemPrompt: "", tools: [], messages, contextWindow: 0 });
		aggregate.categories = {
			user: breakdown.user,
			assistantText: breakdown.assistantText,
			thinking: breakdown.thinking,
			toolCalls: breakdown.toolCalls,
			toolResults: breakdown.toolResults,
			summaries: breakdown.summaries,
			total:
				breakdown.user +
				breakdown.assistantText +
				breakdown.thinking +
				breakdown.toolCalls +
				breakdown.toolResults +
				breakdown.summaries,
		};
	} catch {
		// Category estimation is best-effort; per-model/day totals above still stand.
	}

	return aggregate;
}

/**
 * Aggregate token usage across all session files modified since `sinceMs`.
 * Never throws; on total failure returns an empty aggregate.
 */
export function collectUsageHistory(options: { sinceMs: number; sessionsDir?: string }): UsageHistory {
	const result = emptyHistory();
	try {
		const sessionsDir = options.sessionsDir ?? getSessionsDir();
		const files = enumerateSessionFiles(sessionsDir);
		const seen = new Set<string>();

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

			if (aggregate.hasUsage) result.sessionsWithUsage++;
			for (const row of aggregate.perModel.values()) {
				let target = result.perModel.find((r) => r.model === row.model);
				if (!target) {
					target = { model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					result.perModel.push(target);
				}
				target.input += row.input;
				target.output += row.output;
				target.cacheRead += row.cacheRead;
				target.cacheWrite += row.cacheWrite;
				target.total += row.total;
			}
			for (const [day, total] of aggregate.perDay) {
				const existing = result.perDay.find((r) => r.day === day);
				if (existing) {
					existing.total += total;
				} else {
					result.perDay.push({ day, total });
				}
			}
			for (const key of [
				"user",
				"assistantText",
				"thinking",
				"toolCalls",
				"toolResults",
				"summaries",
				"total",
			] as const) {
				result.categories[key] += aggregate.categories[key];
			}
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
