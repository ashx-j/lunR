// lunr: session retention pruning (Phase 5 of lunr-ux plan).
// Scans the sessions root (~/.lunr/agent/sessions/, layout: <root>/--<cwd>--/*.jsonl,
// or a flat custom --session-dir) and deletes .jsonl session files older than the
// configured retention window. The active session file is always excluded.

import type { Dirent } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PruneOldSessionsOptions {
	/** Absolute path of the active session file; never deleted. */
	excludeFile?: string;
	/** Reference timestamp in ms (defaults to Date.now()); injectable for tests. */
	now?: number;
}

export interface PruneOldSessionsResult {
	/** Paths of session files that were deleted. */
	deleted: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sameFile(a: string, b: string): boolean {
	const ra = resolve(a);
	const rb = resolve(b);
	// Windows paths are case-insensitive.
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

async function pruneDir(
	dir: string,
	cutoffMs: number,
	excludeFile: string | undefined,
	deleted: string[],
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // Missing or unreadable directory: nothing to prune.
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const filePath = join(dir, entry.name);
		if (excludeFile && sameFile(filePath, excludeFile)) continue;
		try {
			const info = await stat(filePath);
			if (info.mtimeMs < cutoffMs) {
				await unlink(filePath);
				deleted.push(filePath);
			}
		} catch {
			// Per-file errors (stat/unlink races, permissions) must never break startup.
		}
	}
}

/**
 * Delete .jsonl session files older than `retentionDays` under `sessionsRoot`.
 * Covers both layouts: project subdirectories (<root>/--<cwd>--/*.jsonl) and flat
 * custom session dirs (<root>/*.jsonl). `retentionDays <= 0` keeps everything.
 */
export async function pruneOldSessions(
	sessionsRoot: string,
	retentionDays: number,
	options: PruneOldSessionsOptions = {},
): Promise<PruneOldSessionsResult> {
	const deleted: string[] = [];
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
		return { deleted };
	}
	const now = options.now ?? Date.now();
	const cutoffMs = now - retentionDays * DAY_MS;

	// Flat layout (custom --session-dir).
	await pruneDir(sessionsRoot, cutoffMs, options.excludeFile, deleted);

	// Project layout (<root>/<dir>/*.jsonl).
	let subdirs: Dirent[];
	try {
		subdirs = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return { deleted };
	}
	for (const entry of subdirs) {
		if (entry.isDirectory()) {
			await pruneDir(join(sessionsRoot, entry.name), cutoffMs, options.excludeFile, deleted);
		}
	}
	return { deleted };
}
