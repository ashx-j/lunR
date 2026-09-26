import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { ReasoningDisplay } from "../../../core/settings-manager.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { CopyableTextBlockComponent, type CopyableTextStatus, parseCopyableTextSegments } from "./copyable-text.ts";
import {
	formatThoughtDuration,
	isThinkingRunComplete,
	type ThinkingRunTiming,
	thinkingSnippet,
} from "./thinking-summary.ts";
import { ThinkingLineComponent, ThinkingTailComponent } from "./thinking-tail.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface AssistantMessageOptions {
	copyText?: (text: string) => Promise<void>;
	requestRender?: () => void;
	reasoningDisplay?: ReasoningDisplay;
	onThinkingAnimationChange?: (active: boolean) => void;
}

interface CopyState {
	payload: string;
	status: CopyableTextStatus;
}

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
	private readonly copyText: (text: string) => Promise<void>;
	private readonly requestRender: () => void;
	private readonly copyStates = new Map<string, CopyState>();
	private reasoningDisplay: ReasoningDisplay;
	private readonly onThinkingAnimationChange?: (active: boolean) => void;
	private readonly thinkingAnimationStart = performance.now();
	private thinkingAnimationActive = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		thinkingCollapse = false,
		options: AssistantMessageOptions = {},
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.thinkingCollapse = thinkingCollapse;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.copyText = options.copyText ?? copyToClipboard;
		this.requestRender = options.requestRender ?? (() => {});
		this.reasoningDisplay = options.reasoningDisplay ?? "auto";
		this.onThinkingAnimationChange = options.onThinkingAnimationChange;

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

	setReasoningDisplay(display: ReasoningDisplay): void {
		this.reasoningDisplay = display;
		if (this.lastMessage) this.updateContent(this.lastMessage, this.thinkingSourceOptions());
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

	handleClick(localY: number, width: number, localX?: number): boolean {
		const contentWidth = width;
		let y = 0;
		for (const child of this.contentContainer.children) {
			const h = child.render(contentWidth).length;
			if (localY >= y && localY < y + h) {
				if (typeof child.handleClick === "function") {
					return child.handleClick(localY - y, contentWidth, localX);
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
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) return lines;

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];

		return lines;
	}

	private thinkingSourceOptions(): { thinkingSource?: AssistantMessage } | undefined {
		return this.thinkingSource ? { thinkingSource: this.thinkingSource } : undefined;
	}

	updateContent(message: AssistantMessage, options?: { thinkingSource?: AssistantMessage }): void {
		this.lastMessage = message;
		this.thinkingSource = options?.thinkingSource;
		this.thinkingAnimationActive = false;

		// Clear content container
		this.contentContainer.clear();

		const sourceMessage = this.thinkingSource ?? message;
		const sourceThinkingRuns = collectThinkingRuns(sourceMessage.content);
		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && c.text.trim()) ||
				(!this.hideThinkingBlock && c.type === "thinking" && c.thinking.trim()),
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
				for (const segment of parseCopyableTextSegments(content.text)) {
					if (segment.type === "markdown") {
						const trimmed = segment.text.trim();
						if (!trimmed) continue;
						const text = isFirstTextBlock ? `● ${trimmed}` : trimmed;
						isFirstTextBlock = false;
						this.contentContainer.addChild(
							new Markdown(text, this.outputPad, 0, this.markdownTheme, {
								color: (body: string) => theme.fg("userMessageText", body),
							}),
						);
						continue;
					}

					const key = `${i}:${segment.start}`;
					const copyState = this.copyStates.get(key);
					const status = copyState?.payload === segment.payload ? copyState.status : "idle";
					if (copyState && copyState.payload !== segment.payload) this.copyStates.delete(key);
					this.contentContainer.addChild(
						new CopyableTextBlockComponent(segment.payload, segment.complete, this.outputPad, status, () =>
							this.copyPayload(key, segment.payload),
						),
					);
				}
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

				if (displayBlocks.length === 0 || this.hideThinkingBlock) {
					continue;
				}

				const sourceBlocks = sourceThinkingRuns[thinkingRunIndex] ?? [];
				const fullyRevealed =
					displayBlocks.length === sourceBlocks.length &&
					displayBlocks.every((block, index) => block === sourceBlocks[index]);
				this.renderThinkingRun(thinkingRunIndex, displayBlocks, message, i, fullyRevealed);
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
		this.onThinkingAnimationChange?.(this.thinkingAnimationActive);
	}

	private copyPayload(key: string, payload: string): void {
		if (this.copyStates.get(key)?.status === "copying") return;
		this.copyStates.set(key, { payload, status: "copying" });
		this.refreshCopyStatus();

		Promise.resolve()
			.then(() => this.copyText(payload))
			.then(() => {
				this.copyStates.set(key, { payload, status: "copied" });
				this.refreshCopyStatus();
			})
			.catch((error: unknown) => {
				const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
				this.copyStates.set(key, { payload, status: { error: message || "Unknown error" } });
				this.refreshCopyStatus();
			});
	}

	private refreshCopyStatus(): void {
		if (this.lastMessage) this.updateContent(this.lastMessage, this.thinkingSourceOptions());
		this.requestRender();
	}

	private renderThinkingRun(
		thinkingRunIndex: number,
		thinkingBlocks: string[],
		displayMessage: AssistantMessage,
		displayIndex: number,
		fullyRevealed: boolean,
	): void {
		const hasVisibleContentAfter =
			displayIndex >= 0
				? displayMessage.content
						.slice(displayIndex + 1)
						.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()))
				: displayMessage.content.some((c) => c.type === "text" && c.text.trim());

		// Provider completion can precede the reveal cursor; keep animating until it catches up.
		const runComplete =
			fullyRevealed &&
			isThinkingRunComplete(false, this.thinkingTimings?.[thinkingRunIndex], this.thinkingTimings !== undefined);
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
			const joinedThinking = thinkingBlocks.join("\n\n");
			const snippet = thinkingSnippet(
				displayMessage.provider === "openai-codex" ? joinedThinking.replaceAll("**", "") : joinedThinking,
			);
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
			const oneLine =
				this.reasoningDisplay === "one-line" ||
				(this.reasoningDisplay === "auto" && displayMessage.provider === "openai-codex");
			if (oneLine) {
				this.thinkingAnimationActive = true;
				// The line owns its vertical padding, including the initial message spacer.
				if (this.contentContainer.children.length === 1 && this.contentContainer.children[0] instanceof Spacer) {
					this.contentContainer.clear();
				}
				wrap(
					new ThinkingLineComponent(
						thinkingBlocks.join("\n\n"),
						this.outputPad,
						this.markdownTheme,
						this.thinkingAnimationStart,
					),
				);
				return;
			}
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
		runs.push(blocks);
	}
	return runs;
}
