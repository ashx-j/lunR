import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import {
	formatThoughtDuration,
	isThinkingRunComplete,
	type ThinkingRunTiming,
	thinkingSnippet,
} from "./thinking-summary.ts";
import { ThinkingTailComponent } from "./thinking-tail.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	selectable = true;
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	// lunr: collapsible reasoning — when true, a completed thinking run renders as
	// "✻ Thought for Xs" + its first sentence instead of the full block.
	private thinkingCollapse: boolean;
	// lunr: per-run expand. `expanded` still means "all runs" for setExpanded().
	private expanded = false;
	private expandedRuns = new Set<number>();
	// lunr: live per-run timings from interactive-mode; undefined = history message
	// (always treated as final, rendered without durations).
	private thinkingTimings?: ThinkingRunTiming[];
	private markdownTheme: MarkdownTheme;
	// lunr: kept for the deferred alternative hidden-thinking indicator (Phase 8 removed the label render).
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for future use
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private thinkingSource?: AssistantMessage;
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
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	// lunr: collapsible reasoning toggles (live; re-render like setHideThinkingBlock).
	setThinkingCollapse(collapse: boolean): void {
		this.thinkingCollapse = collapse;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	// lunr: Expandable hook; true expands every thinking run, false collapses all.
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) this.expandedRuns.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	private isRunExpanded(runIndex: number): boolean {
		return this.expanded || this.expandedRuns.has(runIndex);
	}

	toggleThinkingRun(runIndex: number): void {
		if (this.expanded) {
			this.expanded = false;
			this.expandedRuns.clear();
			const count = this.lastMessage ? collectThinkingRuns(this.lastMessage.content).length : 0;
			for (let i = 0; i < count; i++) {
				if (i !== runIndex) this.expandedRuns.add(i);
			}
		} else if (this.expandedRuns.has(runIndex)) {
			this.expandedRuns.delete(runIndex);
		} else {
			this.expandedRuns.add(runIndex);
		}
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	handleClick(localY: number, width: number): boolean {
		const contentWidth = this.gutterRail ? Math.max(1, width - 2) : width;
		let y = 0;
		for (const child of this.contentContainer.children) {
			const h = child.render(contentWidth).length;
			if (localY >= y && localY < y + h) {
				if (typeof child.handleClick === "function") {
					return child.handleClick(localY - y, contentWidth);
				}
				return false;
			}
			y += h;
		}
		return false;
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
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.thinkingSourceOptions());
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

	private thinkingSourceOptions(): { thinkingSource?: AssistantMessage } | undefined {
		return this.thinkingSource ? { thinkingSource: this.thinkingSource } : undefined;
	}

	updateContent(message: AssistantMessage, options?: { thinkingSource?: AssistantMessage }): void {
		this.lastMessage = message;
		this.thinkingSource = options?.thinkingSource;

		// Clear content container
		this.contentContainer.clear();

		const sourceMessage = this.thinkingSource ?? message;
		const sourceThinkingRuns = collectThinkingRuns(sourceMessage.content);
		const hasVisibleContent =
			message.content.some(
				(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
			) ||
			(!this.hideThinkingBlock && sourceThinkingRuns.some((run) => run.length > 0));

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let isFirstTextBlock = true;
		let thinkingRunIndex = -1;
		let renderedThinking = false;
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
				const displayBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						displayBlocks.push(thinking);
					}
				}
				i--;

				const thinkingBlocks = sourceThinkingRuns[thinkingRunIndex] ?? displayBlocks;
				if (thinkingBlocks.length === 0 || this.hideThinkingBlock) {
					continue;
				}

				renderedThinking = true;
				this.renderThinkingRun(thinkingRunIndex, thinkingBlocks, message, i);
			}
		}

		if (!this.hideThinkingBlock && !renderedThinking && sourceThinkingRuns.length > 0) {
			thinkingRunIndex = 0;
			const thinkingBlocks = sourceThinkingRuns[0] ?? [];
			if (thinkingBlocks.length > 0) {
				this.renderThinkingRun(thinkingRunIndex, thinkingBlocks, message, -1);
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

	private renderThinkingRun(
		thinkingRunIndex: number,
		thinkingBlocks: string[],
		displayMessage: AssistantMessage,
		displayIndex: number,
	): void {
		const hasVisibleContentAfter =
			displayIndex >= 0
				? displayMessage.content
						.slice(displayIndex + 1)
						.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()))
				: displayMessage.content.some((c) => c.type === "text" && c.text.trim());

		const runComplete = isThinkingRunComplete(
			false,
			this.thinkingTimings?.[thinkingRunIndex],
			this.thinkingTimings !== undefined,
		);
		const wrap = (inner: Component): void => {
			this.contentContainer.addChild(new ThinkingRunBlock(this, thinkingRunIndex, inner));
		};
		if (this.thinkingCollapse && !this.isRunExpanded(thinkingRunIndex) && runComplete) {
			const timing = this.thinkingTimings?.[thinkingRunIndex];
			const label =
				timing?.end !== undefined
					? `✻ Thought for ${formatThoughtDuration(timing.end - timing.start)}`
					: "✻ Thought";
			const block = new Container();
			block.addChild(new Text(theme.fg("thinkingText", theme.italic(label)), this.outputPad, 0));
			const snippet = thinkingSnippet(thinkingBlocks.join("\n\n"));
			if (snippet) {
				block.addChild(new Text(theme.fg("thinkingText", theme.italic(snippet)), this.outputPad + 2, 0));
			}
			wrap(block);
			if (hasVisibleContentAfter) {
				this.contentContainer.addChild(new Spacer(1));
			}
			return;
		}
		if (!runComplete && !this.isRunExpanded(thinkingRunIndex)) {
			wrap(
				new ThinkingTailComponent(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				}),
			);
			if (hasVisibleContentAfter) {
				this.contentContainer.addChild(new Spacer(1));
			}
			return;
		}
		wrap(
			new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("thinkingText", text),
				italic: true,
			}),
		);
		if (hasVisibleContentAfter) {
			this.contentContainer.addChild(new Spacer(1));
		}
	}
}

class ThinkingRunBlock extends Container {
	private readonly owner: AssistantMessageComponent;
	private readonly runIndex: number;

	constructor(owner: AssistantMessageComponent, runIndex: number, inner: Component) {
		super();
		this.owner = owner;
		this.runIndex = runIndex;
		this.addChild(inner);
	}

	handleClick(_localY: number, _width: number): boolean {
		this.owner.toggleThinkingRun(this.runIndex);
		return true;
	}
}

function collectThinkingRuns(content: AssistantMessage["content"]): string[][] {
	const runs: string[][] = [];
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block.type !== "thinking") continue;
		const blocks: string[] = [];
		for (; i < content.length; i++) {
			const thinkingContent = content[i];
			if (thinkingContent.type !== "thinking") {
				i--;
				break;
			}
			const thinking = thinkingContent.thinking.trim();
			if (thinking) blocks.push(thinking);
		}
		if (blocks.length > 0) runs.push(blocks);
	}
	return runs;
}
