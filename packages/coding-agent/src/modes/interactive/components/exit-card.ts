/**
 * lunR: exit summary card — printed on /quit (and ctrl+c/ctrl+d exit) after a
 * real session. Computes turns, tokens, and files changed from the session
 * entries and renders a dim bordered box with moon art left, stats right.
 *
 * Reuses core/compaction/utils.ts file-ops helpers (same as branch summaries).
 */

import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../../../core/compaction/utils.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { MOON_ASCII_SMALL } from "./boot-ascii.ts";

/** Compact token formatting: 12345 → "12.3k", 1234567 → "1.2M". */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export interface ExitCardStats {
	turns: number;
	tokens: number;
	filesChanged: number;
}

/** Compute turns (user-message count), total tokens, and files changed. */
export function computeExitCardStats(entries: readonly SessionEntry[]): ExitCardStats {
	let turns = 0;
	let tokens = 0;
	const fileOps = createFileOps();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			turns++;
		} else if (message.role === "assistant") {
			const usage = message.usage;
			if (usage) {
				tokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
			}
			extractFileOpsFromMessage(message, fileOps);
		}
	}

	const { modifiedFiles } = computeFileLists(fileOps);
	return { turns, tokens, filesChanged: modifiedFiles.length };
}

/**
 * Render the exit card as a dim rounded box. Returns the card lines (no ANSI
 * dim wrapping — callers may dim the whole box). Returns [] for empty sessions
 * (0 user messages) so callers can skip printing.
 */
export function buildExitCard(stats: ExitCardStats): string[] {
	if (stats.turns === 0) return [];

	const moon = MOON_ASCII_SMALL[0] ?? "☾";
	const line1 = `${moon}   ${stats.turns} turn${stats.turns === 1 ? "" : "s"} · ${formatTokens(stats.tokens)} tok`;
	const line2 = `${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"} changed`;

	// Inner content width: the longest of the two stat lines, with the moon art
	// reserved on line 1. Line 2 is indented to align past the moon glyph.
	const moonPad = "      "; // align stats past the moon glyph column
	const innerLeft = `  ${line1}`;
	const innerRight = `  ${moonPad}${line2}`;
	const innerWidth = Math.max(innerLeft.length, innerRight.length);

	const pad = (s: string) => `${s}${" ".repeat(Math.max(0, innerWidth - s.length))}`;
	const top = `╭${"─".repeat(innerWidth + 2)}╮`;
	const bottom = `╰${"─".repeat(innerWidth + 2)}╯`;
	const body1 = `│ ${pad(innerLeft)} │`;
	const body2 = `│ ${pad(innerRight)} │`;

	return [top, body1, body2, bottom];
}
