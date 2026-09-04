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

	constructor(summary: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.summary = summary;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.fg("accent", theme.bold("Plan")), this.outputPad, 0));
		this.addChild(new Markdown(planMessageMarkdown(this.summary), this.outputPad, 0, this.markdownTheme));
	}
}
