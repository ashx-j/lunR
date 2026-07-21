import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	// lunr: gutter rail — prefix rendered lines with a dim │ (last line ╰ when this
	// component closes a turn; user messages open the rail so all lines use │).
	private gutterRail: boolean;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1, gutterRail = false) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.gutterRail = gutterRail;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setGutterRail(enabled: boolean): void {
		this.gutterRail = enabled;
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		// lunr: leading ● marks the first line of a user message. Kept uncolored in the
		// markdown source so the message's own text color applies (white in moon theme);
		// embedding ANSI here would strip the text color from the rest of the paragraph.
		contentBox.addChild(
			new Markdown(
				`● ${this.text}`,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		// lunr: gutter rail — render content at width-2 and prefix each line with a
		// dim │ so a thin rail runs down the left of the user message.
		const railEnabled = this.gutterRail;
		const contentWidth = railEnabled ? Math.max(1, width - 2) : width;
		const lines = super.render(contentWidth);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];

		if (railEnabled) {
			const rail = theme.fg("dim", "│ ");
			for (let i = 0; i < lines.length; i++) {
				lines[i] = rail + lines[i];
			}
		}
		return lines;
	}
}
