import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

/**
 * Smooth streaming helpers: reveal assistant text/thinking grapheme by
 * grapheme instead of flashing whole chunks. The displayed message is a
 * shallow copy of the streaming target, truncated to N graphemes total
 * across its text and thinking blocks.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function countGraphemes(text: string): number {
	let count = 0;
	for (const _ of graphemeSegmenter.segment(text)) {
		count++;
	}
	return count;
}

function takeGraphemes(text: string, max: number): string {
	if (max <= 0) return "";
	let count = 0;
	let end = 0;
	for (const segment of graphemeSegmenter.segment(text)) {
		if (count >= max) break;
		count++;
		end = segment.index + segment.segment.length;
	}
	return text.slice(0, end);
}

/** Total graphemes across a message's text and thinking blocks. */
export function countMessageGraphemes(message: AssistantMessage): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += countGraphemes(block.text);
		} else if (block.type === "thinking") {
			total += countGraphemes(block.thinking);
		}
	}
	return total;
}

/**
 * Shallow copy of `message` with text/thinking blocks truncated to
 * `maxGraphemes` graphemes in total (block order preserved, never splits
 * inside a grapheme). Tool call blocks pass through untouched.
 */
export function sliceMessageContent(message: AssistantMessage, maxGraphemes: number): AssistantMessage {
	let remaining = maxGraphemes;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const text = takeGraphemes(block.text, remaining);
			remaining -= countGraphemes(text);
			return text === block.text ? block : { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = takeGraphemes(block.thinking, remaining);
			remaining -= countGraphemes(thinking);
			return thinking === block.thinking ? block : { ...block, thinking };
		}
		return block;
	});
	return { ...message, content };
}
