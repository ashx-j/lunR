import { type Component, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * lunr: rolling window for a still-streaming thinking run. Renders the full
 * Markdown block (same styling as the complete-run branch) but returns only
 * the last `maxLines` rendered lines, so at most N visual lines of reasoning
 * are on screen at a time and older lines disappear as new ones stream in.
 * Applied render-time only; the transcript is untouched.
 */

/** Maximum rendered lines shown for a streaming thinking run. */
export const THINKING_TAIL_LINES = 4;

export class ThinkingTailComponent implements Component {
	private markdown: Markdown;
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
		if (lines.length <= this.maxLines) {
			return lines;
		}
		return lines.slice(-this.maxLines);
	}
}
