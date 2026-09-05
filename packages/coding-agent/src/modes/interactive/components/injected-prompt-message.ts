import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { INJECTED_PROMPT_LABELS, type InjectedPromptKind } from "../../../core/injected-prompt.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * lunr: renders an injected prompt (/research, /goal) as a collapsed
 * one-line summary instead of the full multi-line prompt body. The model still
 * receives the complete prompt — this is a transcript-rendering affordance only.
 *
 * Collapsible to match the skill-invocation message convention.
 */
export class InjectedPromptMessageComponent extends Box {
	private expanded = false;
	private readonly kind: InjectedPromptKind;
	private readonly summary: string;
	private readonly fullText: string;
	private readonly markdownTheme: MarkdownTheme;

	constructor(
		kind: InjectedPromptKind,
		summary: string,
		fullText: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.kind = kind;
		this.summary = summary;
		this.fullText = fullText;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const label = INJECTED_PROMPT_LABELS[this.kind];

		if (this.expanded) {
			this.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`), 0, 0));
			this.addChild(
				new Markdown(this.fullText, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m `) +
				theme.fg("customMessageText", this.summary) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
