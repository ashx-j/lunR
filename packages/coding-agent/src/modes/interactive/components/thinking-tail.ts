import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

/**
 * lunr: rolling window for a still-streaming thinking run. Renders the full
 * Markdown block (same styling as the complete-run branch) but returns only
 * the last `maxLines` rendered lines, so at most N visual lines of reasoning
 * are on screen at a time and older lines disappear as new ones stream in.
 * Short tails are not padded to `maxLines`. The slot grows 1→4, then rolls.
 * Applied render-time only; the transcript is untouched.
 */

/** Maximum rendered lines shown for a streaming thinking run. */
export const THINKING_TAIL_LINES = 4;

export class ThinkingTailComponent implements Component {
	protected markdown: Markdown;
	private maxLines: number;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		markdownTheme: MarkdownTheme,
		options?: { color?: (text: string) => string; italic?: boolean },
		maxLines: number = THINKING_TAIL_LINES,
	) {
		this.maxLines = maxLines;
		this.markdown = new Markdown(text, paddingX, paddingY, markdownTheme, options);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		return lines.length <= this.maxLines ? lines : lines.slice(-this.maxLines);
	}
}

const shimmerSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SHIMMER_PERIOD_MS = 2800;

export class ThinkingLineComponent extends ThinkingTailComponent {
	private readonly startedAt: number;
	private palette = theme.getFgGradient("thinkingText", "white", 32);

	constructor(text: string, paddingX: number, markdownTheme: MarkdownTheme, startedAt: number) {
		super(text, paddingX, 0, markdownTheme);
		this.startedAt = startedAt;
	}

	override invalidate(): void {
		super.invalidate();
		this.palette = theme.getFgGradient("thinkingText", "white", 32);
	}

	override render(width: number): string[] {
		if (width <= 0) return ["", ""];
		const lines = this.markdown.render(width);
		let latest = "";
		for (let index = lines.length - 1; index >= 0; index--) {
			latest = stripAnsi(lines[index]).trimEnd();
			if (latest.trim()) break;
		}
		const text = stripAnsi(truncateToWidth(latest, width, ""));
		const length = visibleWidth(text);
		const band = Math.max(6, Math.min(18, length * 0.3));
		const progress = ((performance.now() - this.startedAt) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
		const center = -band + progress * (length + band * 2);
		let column = 0;
		let highlighted = "";
		for (const { segment } of shimmerSegmenter.segment(text)) {
			const cells = visibleWidth(segment);
			const distance = Math.abs(column + cells / 2 - center) / band;
			const intensity = distance >= 1 ? 0 : (1 + Math.cos(Math.PI * distance)) / 2;
			highlighted += this.palette[Math.round(intensity * (this.palette.length - 1))] + segment;
			column += cells;
		}
		return ["", `\x1b[3m${highlighted}\x1b[23m\x1b[39m`];
	}
}
