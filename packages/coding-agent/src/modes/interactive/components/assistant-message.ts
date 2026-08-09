import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import {
	formatThoughtDuration,
	isThinkingRunComplete,
	type ThinkingRunTiming,
	thinkingSnippet,
} from "./thinking-summary.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	// lunr: collapsible reasoning — when true, a completed thinking run renders as
	// "✻ Thought for Xs" + its first sentence instead of the full block.
	private thinkingCollapse: boolean;
	// lunr: ctrl+o expansion — when true, collapsed thinking runs render in full
	// (wired into the global app.tools.expand toggle via the Expandable interface).
	private expanded = false;
	// lunr: live per-run timings from interactive-mode; undefined = history message
	// (always treated as final, rendered without durations).
	private thinkingTimings?: ThinkingRunTiming[];
	private markdownTheme: MarkdownTheme;
	// lunr: kept for the deferred alternative hidden-thinking indicator (Phase 8 removed the label render).
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for future use
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	// lunr: gutter rail — prefix rendered lines with a dim │; the last line uses ╰
	// when this component closes the turn (no tool calls follow).
	private gutterRail: boolean;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		gutterRail = false,
		thinkingCollapse = false,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.thinkingCollapse = thinkingCollapse;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.gutterRail = gutterRail;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	// lunr: collapsible reasoning toggles (live; re-render like setHideThinkingBlock).
	setThinkingCollapse(collapse: boolean): void {
		this.thinkingCollapse = collapse;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	// lunr: ctrl+o expansion — Expandable interface hook; expanded collapsed thinking
	// runs render as full Markdown blocks again.
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setThinkingTimings(timings: ThinkingRunTiming[] | undefined): void {
		this.thinkingTimings = timings;
	}

	// lunr: gutter rail toggle (live; applied on next render).
	setGutterRail(enabled: boolean): void {
		this.gutterRail = enabled;
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		// lunr: gutter rail — render content at width-2 and prefix each line with a
		// dim │; the last line uses ╰ when this assistant message closes the turn
		// (no tool calls follow). When tool calls are present the rail stays open (│)
		// because tool-execution components render their own borders below.
		const railEnabled = this.gutterRail;
		const contentWidth = railEnabled ? Math.max(1, width - 2) : width;
		const lines = super.render(contentWidth);
		if (this.hasToolCalls || lines.length === 0) {
			if (railEnabled && lines.length > 0) {
				const rail = theme.fg("dim", "│ ");
				for (let i = 0; i < lines.length; i++) {
					lines[i] = rail + lines[i];
				}
			}
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];

		if (railEnabled) {
			const rail = theme.fg("dim", "│ ");
			const close = theme.fg("dim", "╰ ");
			for (let i = 0; i < lines.length; i++) {
				lines[i] = (i === lines.length - 1 ? close : rail) + lines[i];
			}
		}
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let isFirstTextBlock = true;
		let thinkingRunIndex = -1;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				// lunr: leading ● marks the first text block (never thinking blocks). It rides
				// the defaultTextStyle below, so it renders bright white like the body.
				const trimmed = content.text.trim();
				const text = isFirstTextBlock ? `● ${trimmed}` : trimmed;
				isFirstTextBlock = false;
				// lunr: theme-polish — assistant message body renders bright white via the
				// shared userMessageText token (same knob as user messages).
				this.contentContainer.addChild(
					new Markdown(text, this.outputPad, 0, this.markdownTheme, {
						color: (body: string) => theme.fg("userMessageText", body),
					}),
				);
			} else if (content.type === "thinking") {
				thinkingRunIndex++;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// lunr: thinking blocks are hidden — render nothing (the "Thinking..." label is
					// removed; an alternative hidden indicator will be designed separately).
				} else if (
					this.thinkingCollapse &&
					!this.expanded &&
					isThinkingRunComplete(
						i < message.content.length - 1,
						this.thinkingTimings?.[thinkingRunIndex],
						this.thinkingTimings !== undefined,
					)
				) {
					// lunr: collapsible reasoning — a completed run collapses to
					// "✻ Thought for Xs" (duration only from live timings) + its first sentence.
					const timing = this.thinkingTimings?.[thinkingRunIndex];
					const label =
						timing?.end !== undefined
							? `✻ Thought for ${formatThoughtDuration(timing.end - timing.start)}`
							: "✻ Thought";
					this.contentContainer.addChild(
						new Text(theme.fg("thinkingText", theme.italic(label)), this.outputPad, 0),
					);
					const snippet = thinkingSnippet(thinkingBlocks.join("\n\n"));
					if (snippet) {
						this.contentContainer.addChild(
							new Text(theme.fg("thinkingText", theme.italic(snippet)), this.outputPad + 2, 0),
						);
					}
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					// lunr: only add the spacer when thinking is visible (avoids stray blank line when hidden).
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
