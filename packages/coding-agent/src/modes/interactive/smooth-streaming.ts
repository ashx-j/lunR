import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai/compat";

/**
 * Smooth streaming helpers: reveal assistant text/thinking grapheme by
 * grapheme instead of flashing whole chunks. The displayed message is a
 * shallow copy of the streaming target, truncated to N graphemes total
 * across its visible text/thinking blocks.
 *
 * Providers mutate block.text / block.thinking in place on the same content
 * objects, so segment state is cached per block identity with append-only
 * incremental re-segmentation (only the last grapheme cluster may change).
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Default base reveal speed (graphemes per tick) and hard per-tick cap. */
export const SMOOTH_STREAMING_BASE_GRAPHEMES_PER_TICK = 4;
export const SMOOTH_STREAMING_MAX_GRAPHEMES_PER_TICK = 48;

export interface SmoothStreamingOptions {
	/** When true, thinking blocks are excluded from the reveal budget and output. */
	hideThinking?: boolean;
}

/**
 * Catch-up step size: grow with backlog, but never explode markdown reparses.
 * Exported for unit tests.
 */
export function computeSmoothRevealStep(
	backlog: number,
	base: number = SMOOTH_STREAMING_BASE_GRAPHEMES_PER_TICK,
	max: number = SMOOTH_STREAMING_MAX_GRAPHEMES_PER_TICK,
): number {
	if (backlog <= 0) return 0;
	return Math.min(max, Math.max(base, Math.ceil(backlog / 8)));
}

/**
 * Per-block grapheme counter. Handles in-place append mutations from streaming
 * providers without re-segmenting the entire string every tick.
 */
export class BlockUnitCounter {
	private source = "";
	private ends: number[] = [];

	get count(): number {
		return this.ends.length;
	}

	get text(): string {
		return this.source;
	}

	/** Recompute or incrementally extend segments for `text`. */
	update(text: string): void {
		if (text === this.source) return;

		// Pure append (the common streaming path): only the last grapheme cluster
		// may still be incomplete (ZWJ emoji, combining marks, etc.), so drop it
		// and re-segment from the previous stable boundary.
		if (text.startsWith(this.source)) {
			if (this.ends.length > 0) {
				this.ends.pop();
			}
			const sliceFrom = this.ends.length > 0 ? this.ends[this.ends.length - 1]! : 0;
			for (const segment of graphemeSegmenter.segment(text.slice(sliceFrom))) {
				this.ends.push(sliceFrom + segment.index + segment.segment.length);
			}
			this.source = text;
			return;
		}

		// Truncation or non-append edit: full recompute.
		this.ends = [];
		for (const segment of graphemeSegmenter.segment(text)) {
			this.ends.push(segment.index + segment.segment.length);
		}
		this.source = text;
	}

	/** Prefix of `source` covering the first `maxGraphemes` clusters. */
	slice(maxGraphemes: number): string {
		if (maxGraphemes <= 0) return "";
		if (maxGraphemes >= this.ends.length) return this.source;
		return this.source.slice(0, this.ends[maxGraphemes - 1]!);
	}
}

/** Block-identity cache: content objects are mutated in place during stream. */
const blockCounters = new WeakMap<object, BlockUnitCounter>();

function getBlockCounter(block: object): BlockUnitCounter {
	let counter = blockCounters.get(block);
	if (!counter) {
		counter = new BlockUnitCounter();
		blockCounters.set(block, counter);
	}
	return counter;
}

function isTextBlock(block: TextContent | ThinkingContent | ToolCall): block is TextContent {
	return block.type === "text";
}

function isThinkingBlock(block: TextContent | ThinkingContent | ToolCall): block is ThinkingContent {
	return block.type === "thinking";
}

function blockText(block: TextContent | ThinkingContent): string {
	return isTextBlock(block) ? block.text : block.thinking;
}

function withBlockText(block: TextContent | ThinkingContent, value: string): TextContent | ThinkingContent {
	if (isTextBlock(block)) {
		return value === block.text ? block : { ...block, text: value };
	}
	return value === block.thinking ? block : { ...block, thinking: value };
}

function syncCounter(block: TextContent | ThinkingContent): BlockUnitCounter {
	const counter = getBlockCounter(block);
	counter.update(blockText(block));
	return counter;
}

/** Total visible graphemes across a message's text (and thinking, unless hidden). */
export function countMessageGraphemes(
	message: AssistantMessage,
	options: SmoothStreamingOptions = {},
): number {
	const hideThinking = options.hideThinking === true;
	let total = 0;
	for (const block of message.content) {
		if (isTextBlock(block)) {
			total += syncCounter(block).count;
		} else if (isThinkingBlock(block) && !hideThinking) {
			total += syncCounter(block).count;
		}
	}
	return total;
}

/**
 * Visible graphemes strictly before `toolCallId`. Used to flush the typewriter
 * through leading text when a tool starts executing so the card can appear.
 * Returns the full visible count when the tool id is missing.
 */
export function countGraphemesBeforeToolCall(
	message: AssistantMessage,
	toolCallId: string,
	options: SmoothStreamingOptions = {},
): number {
	const hideThinking = options.hideThinking === true;
	let total = 0;
	for (const block of message.content) {
		if (block.type === "toolCall") {
			if (block.id === toolCallId) return total;
			continue;
		}
		if (isTextBlock(block)) {
			total += syncCounter(block).count;
		} else if (isThinkingBlock(block) && !hideThinking) {
			total += syncCounter(block).count;
		}
	}
	return total;
}

/**
 * Shallow copy of `message` with visible text/thinking truncated to
 * `maxGraphemes` graphemes in order. Tool-call blocks are a reveal boundary:
 * they appear only after all leading visible text/thinking is fully revealed.
 * Leading tool calls (no prior visible text) stay visible even at 0 graphemes.
 */
export function sliceMessageContent(
	message: AssistantMessage,
	maxGraphemes: number,
	options: SmoothStreamingOptions = {},
): AssistantMessage {
	const hideThinking = options.hideThinking === true;
	let remaining = Math.max(0, maxGraphemes);
	let truncated = false;
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];

	for (const block of message.content) {
		if (truncated) break;

		if (isThinkingBlock(block) && hideThinking) {
			// Hidden thinking does not consume budget and is omitted from display.
			continue;
		}

		if (isTextBlock(block) || isThinkingBlock(block)) {
			if (remaining <= 0) {
				// No budget for further text; stop before later tool cards too.
				truncated = true;
				break;
			}
			const counter = syncCounter(block);
			const take = Math.min(remaining, counter.count);
			if (take >= counter.count) {
				content.push(block);
				remaining -= counter.count;
			} else {
				content.push(withBlockText(block, counter.slice(take)));
				remaining = 0;
				// Partial text: hold later tool cards until this block catches up.
				truncated = true;
			}
			continue;
		}

		// toolCall: visible once all prior visible text/thinking is fully revealed.
		// Leading tools (no prior text) pass through even at maxGraphemes === 0.
		content.push(block);
	}

	return { ...message, content };
}
