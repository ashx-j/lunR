/**
 * lunR: gateway text utilities.
 *
 * splitMessage() chunks outbound text to a platform limit. Splits prefer
 * blank-line, then line, then word boundaries near the limit; a chunk never
 * ends with an unclosed ``` code fence (the fence is closed and reopened —
 * with its language tag — in the next chunk); hard splits never break a
 * surrogate pair. Multi-chunk messages get a " (n/m)" indicator, with space
 * reserved up front so decorated chunks still fit the limit.
 */

/** UTF-16 length — identical to s.length; named for call-site clarity. */
export function utf16Len(s: string): number {
	return s.length;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Never cut right after a high surrogate (its low half would lead the next chunk). */
function surrogateSafeCut(s: string, cut: number): number {
	if (cut > 0) {
		const code = s.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) return cut - 1;
	}
	return cut;
}

/** Cut before a grapheme cluster boundary so hard splits never break a cluster. */
function graphemeSafeCut(s: string, maxIndex: number): number {
	if (maxIndex <= 0) return 0;
	let end = 0;
	for (const segment of graphemeSegmenter.segment(s)) {
		const nextEnd = segment.index + segment.segment.length;
		if (nextEnd > maxIndex) break;
		end = nextEnd;
	}
	return surrogateSafeCut(s, end);
}

/** Last blank-line, line, or word boundary inside the window; hard split as last resort. */
function findSplitPoint(window: string, limit: number): number {
	const blank = window.lastIndexOf("\n\n");
	if (blank > 0) return blank + 1;
	const newline = window.lastIndexOf("\n");
	if (newline > 0) return newline + 1;
	const space = window.lastIndexOf(" ");
	if (space > 0) return space + 1;
	return graphemeSafeCut(window, limit);
}

const FENCE_RE = /^\s*```/;

/**
 * Scan chunk lines for fence state at the cut point.
 * Returns the opening fence line (e.g. "```ts") when the chunk ends inside a
 * fence, undefined otherwise.
 */
function openFenceAtEnd(chunk: string): string | undefined {
	let opener: string | undefined;
	for (const line of chunk.split("\n")) {
		if (FENCE_RE.test(line)) {
			opener = opener === undefined ? line.trim() : undefined;
		}
	}
	return opener;
}

const FENCE_CLOSE = "\n```";

/** Greedy fence-aware split with no decoration; every chunk ≤ limit. */
function splitRaw(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (utf16Len(rest) > limit) {
		// Reserve room for the fence close when the cut lands inside a fence.
		// (Fence state depends on the cut, so iterate — converges in 1-2 passes.)
		let cut = findSplitPoint(rest.slice(0, limit), limit);
		let chunk = rest.slice(0, cut).replace(/\s+$/, "");
		let opener = openFenceAtEnd(chunk);
		while (opener !== undefined && chunk.length + FENCE_CLOSE.length > limit) {
			cut = findSplitPoint(rest.slice(0, limit - FENCE_CLOSE.length), limit - FENCE_CLOSE.length);
			chunk = rest.slice(0, cut).replace(/\s+$/, "");
			opener = openFenceAtEnd(chunk);
		}
		if (opener !== undefined && chunk === opener) {
			// Only the fence opener fits: hard-split so the chunk carries content
			// and the loop makes progress.
			cut = graphemeSafeCut(rest, Math.max(1, limit - FENCE_CLOSE.length));
			chunk = rest.slice(0, cut);
			opener = openFenceAtEnd(chunk);
			if (opener !== undefined && chunk === opener) {
				// Opener alone still fills the chunk (pathological tiny limit):
				// give up fence balancing for this chunk.
				cut = graphemeSafeCut(rest, limit);
				chunk = rest.slice(0, cut);
				opener = undefined;
			}
		}
		rest = rest.slice(cut).replace(/^\n+/, "");
		if (opener !== undefined) {
			chunk += FENCE_CLOSE;
			rest = `${opener}\n${rest}`;
		}
		if (chunk.length > 0) chunks.push(chunk);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/** Width of the widest " (n/m)" indicator for m chunks. */
function indicatorReserve(m: number): number {
	return 4 + 2 * String(m).length;
}

/**
 * Split text into chunks of at most max UTF-16 code units each.
 * Multi-chunk results carry a trailing " (n/m)" indicator (counted in max).
 */
export function splitMessage(text: string, max: number): string[] {
	if (max < 1) throw new RangeError("max must be >= 1");
	if (utf16Len(text) <= max) return [text];

	let chunks = splitRaw(text, max);
	if (chunks.length > 1 && max - indicatorReserve(chunks.length) >= 1) {
		const reserve = indicatorReserve(chunks.length);
		const adjusted = splitRaw(text, max - reserve);
		// The smaller limit may push the count across a power of ten (9 → 10),
		// widening the indicator by one char — re-split once in that case.
		chunks =
			indicatorReserve(adjusted.length) === reserve
				? adjusted
				: splitRaw(text, max - indicatorReserve(adjusted.length));
	}
	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, i) => `${chunk} (${i + 1}/${chunks.length})`);
}
