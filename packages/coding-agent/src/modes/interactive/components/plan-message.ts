import { Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/** Markdown source for the live plan chat card. Full summary, no 500-char slice. */
export function planMessageMarkdown(summary: string): string {
	return summary;
}

/**
 * Chat card for present_plan. Lives in the transcript so the dock dialog
 * can stay a short Approve / Decline chooser.
 */
export class PlanMessageComponent extends Container {
	private summary: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private gutterRail: boolean;

	constructor(summary: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1, gutterRail = false) {
		super();
		this.summary = summary;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.gutterRail = gutterRail;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.fg("accent", theme.bold("Plan")), this.outputPad, 0));
		this.addChild(new Markdown(planMessageMarkdown(this.summary), this.outputPad, 0, this.markdownTheme));
	}

	override render(width: number): string[] {
		const railEnabled = this.gutterRail;
		const contentWidth = railEnabled ? Math.max(1, width - 2) : width;
		const lines = super.render(contentWidth);
		if (!railEnabled || lines.length === 0) return lines;
		const rail = theme.fg("dim", "│ ");
		const close = theme.fg("dim", "╰ ");
		for (let i = 0; i < lines.length; i++) {
			lines[i] = (i === lines.length - 1 ? close : rail) + lines[i];
		}
		return lines;
	}
}
