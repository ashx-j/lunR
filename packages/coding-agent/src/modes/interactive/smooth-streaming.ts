import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

/**
 * Smooth streaming helpers: reveal assistant text/thinking grapheme by
 * grapheme instead of flashing whole chunks. The displayed message is a
 * shallow copy of the streaming target, truncated to N graphemes total
 * across its text and thinking blocks.
 *
 * Grapheme segment boundaries are cached per message via a WeakMap so the
 * streaming tick does not re-segment the whole message every 20 ms.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface BlockSegments {
	/** Original text for quick identity checks. */
	source: string;
	/** End index (byte/code-unit) for each grapheme cluster, in order. */
	ends: number[];
}

interface MessageSegments {
	blocks: (BlockSegments | undefined)[];
	/** Total graphemes across text/thinking blocks. */
	total: number;
}

const segmentCache = new WeakMap<AssistantMessage, MessageSegments>();

function computeBlockSegments(text: string): BlockSegments {
	const ends: number[] = [];
	for (const segment of graphemeSegmenter.segment(text)) {
		ends.push(segment.index + segment.segment.length);
	}
	return { source: text, ends };
}

function getMessageSegments(message: AssistantMessage): MessageSegments {
	let cached = segmentCache.get(message);
	if (cached) return cached;

	let total = 0;
	const blocks: (BlockSegments | undefined)[] = message.content.map((block) => {
		if (block.type === "text") {
			const segs = computeBlockSegments(block.text);
			total += segs.ends.length;
			return segs;
		}
		if (block.type === "thinking") {
			const segs = computeBlockSegments(block.thinking);
			total += segs.ends.length;
			return segs;
		}
		return undefined;
	});
	cached = { blocks, total };
	segmentCache.set(message, cached);
	return cached;
}

/** Total graphemes across a message's text and thinking blocks. */
export function countMessageGraphemes(message: AssistantMessage): number {
	return getMessageSegments(message).total;
}

/**
 * Shallow copy of `message` with text/thinking blocks truncated to
 * `maxGraphemes` graphemes in total (block order preserved, never splits
 * inside a grapheme). Tool call blocks pass through untouched.
 */
export function sliceMessageContent(message: AssistantMessage, maxGraphemes: number): AssistantMessage {
	if (maxGraphemes <= 0) {
		// Empty display: preserve tool-call blocks so they remain visible.
		return {
			...message,
			content: message.content.filter((block) => block.type !== "text" && block.type !== "thinking"),
		};
	}

	const { blocks } = getMessageSegments(message);
	let remaining = maxGraphemes;
	const content = message.content.map((block, index) => {
		if (remaining <= 0) {
			// No budget left for this text/thinking block.
			if (block.type === "text" || block.type === "thinking") {
				return undefined;
			}
			return block;
		}

		if (block.type === "text") {
			const segs = blocks[index];
			if (!segs || segs.source !== block.text) {
				// Cache stale (shouldn't happen with immutable messages); fallback.
				return block;
			}
			const take = Math.min(remaining, segs.ends.length);
			const end = take === 0 ? 0 : segs.ends[take - 1];
			const text = block.text.slice(0, end);
			remaining -= take;
			return text === block.text ? block : { ...block, text };
		}

		if (block.type === "thinking") {
			const segs = blocks[index];
			if (!segs || segs.source !== block.thinking) {
				return block;
			}
			const take = Math.min(remaining, segs.ends.length);
			const end = take === 0 ? 0 : segs.ends[take - 1];
			const thinking = block.thinking.slice(0, end);
			remaining -= take;
			return thinking === block.thinking ? block : { ...block, thinking };
		}

		return block;
	});
	return { ...message, content: content.filter((b): b is NonNullable<typeof b> => b !== undefined) };
}
