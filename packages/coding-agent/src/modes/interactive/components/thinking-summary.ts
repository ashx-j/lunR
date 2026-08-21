import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * lunr: pure helpers for the collapsible-reasoning feature. A completed
 * thinking run renders as "✻ Thought for Xs" + the run's first sentence
 * instead of the full block. Kept component-free so vitest can cover the
 * extraction/timing logic directly.
 */

/** Live timing for one thinking run (a maximal run of consecutive thinking blocks). */
export interface ThinkingRunTiming {
	start: number;
	end?: number;
}

/** Leading markdown punctuation stripped before sentence extraction. */
const LEADING_MARKDOWN_RE = /^[#*`>\-\s]+/;

/**
 * Extract a one-line summary from a thinking run: the first sentence of the
 * first substantive line (blank and markdown-only lines skipped). If no
 * sentence terminator appears within `maxLen` chars, hard-truncate at the
 * last word boundary and append an ellipsis.
 */
export function thinkingSnippet(joinedThinking: string, maxLen = 120): string {
	const text = joinedThinking
		.split("\n")
		// Markdown headers are structural labels, not sentences — skip them.
		.filter((line) => !line.trimStart().startsWith("#"))
		.map((line) => line.replace(LEADING_MARKDOWN_RE, "").trim())
		.filter((line) => line.length > 0)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) {
		return "";
	}
	// First sentence: up to a terminator followed by whitespace or end-of-text.
	const sentenceMatch = text.match(/^.*?[.!?](?=\s|$)/);
	if (sentenceMatch && sentenceMatch[0].length <= maxLen) {
		return sentenceMatch[0];
	}
	if (text.length <= maxLen) {
		return text;
	}
	const window = text.slice(0, maxLen);
	const lastSpace = window.lastIndexOf(" ");
	const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
	return `${cut}…`;
}

/** Format a thinking duration: `<1s`, `Ns`, or `Mm Ss`. */
export function formatThoughtDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 1) {
		return "<1s";
	}
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Update per-run timings from the full (un-sliced) streaming message content.
 * A run gets `start` the first time it is seen and `end` (once) when any
 * content block follows it or the message is final.
 */
export function updateThinkingRunTimings(
	timings: ThinkingRunTiming[],
	content: AssistantMessage["content"],
	now: number,
	isFinal: boolean,
): void {
	let runIndex = -1;
	let inThinkingRun = false;
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block.type === "thinking") {
			if (!inThinkingRun) {
				runIndex++;
				inThinkingRun = true;
				if (!timings[runIndex]) {
					timings[runIndex] = { start: now };
				}
			}
			continue;
		}
		if (inThinkingRun) {
			// A non-thinking block follows the run: it is complete.
			const timing = timings[runIndex];
			if (timing && timing.end === undefined) {
				timing.end = now;
			}
			inThinkingRun = false;
		}
	}
	if (isFinal && inThinkingRun) {
		const timing = timings[runIndex];
		if (timing && timing.end === undefined) {
			timing.end = now;
		}
	}
}

/**
 * Whether a thinking run is complete and may collapse. Note: partial streaming
 * messages carry `stopReason: "stop"` from the start, so stopReason cannot be
 * used. History / resumed messages have no timings and are always final. A
 * live run stays open until its timing records `end` — a following empty
 * block must not collapse it early.
 */
export function isThinkingRunComplete(
	_hasFollowingBlock: boolean,
	timing: ThinkingRunTiming | undefined,
	timingsAttached: boolean,
): boolean {
	if (!timingsAttached) return true;
	return timing?.end !== undefined;
}
