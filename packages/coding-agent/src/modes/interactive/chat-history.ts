/**
 * Chat history rendering for interactive mode: drawing the session's messages and custom entries
 * into the chat on load, after /tree, /resume or a compaction, and as messages arrive, plus the
 * cache-miss and history-replay notices. InteractiveMode supplies the chat, the display state the
 * components need and its tool card helpers through ChatHistoryHost.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CLAUDE_CODE_HISTORY_REPLAYED_NOTE, claudeCodeHistoryReplayed } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import {
	type Container,
	type EditorComponent,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { type AgentSession, parseSkillBlock } from "../../core/agent-session.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses, detectCacheMiss } from "../../core/cache-stats.ts";
import { detectInjectedPrompt } from "../../core/injected-prompt.ts";
import { type SessionEntry, type SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { type FooterComponent, formatTokens } from "./components/footer.ts";
import { InjectedPromptMessageComponent } from "./components/injected-prompt-message.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import type { ThinkingRunTiming } from "./components/thinking-summary.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { theme } from "./theme/theme.ts";

/** What chat history rendering needs from InteractiveMode. InteractiveMode builds one in `createChatHistoryHost`. */
export interface ChatHistoryHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly editor: EditorComponent;
	readonly footer: FooterComponent;
	/** The assistant message still streaming; custom entries go in before it. */
	readonly streamingComponent: AssistantMessageComponent | undefined;
	/** Tool cards still waiting for a result; a rebuild refills it. */
	readonly pendingTools: Map<string, ToolExecutionComponent>;
	readonly thinkingTimingsByMessage: WeakMap<AssistantMessage, ThinkingRunTiming[]>;
	// Display state the components are created with.
	readonly toolOutputExpanded: boolean;
	readonly hideThinkingBlock: boolean;
	readonly thinkingCollapse: boolean;
	readonly hiddenThinkingLabel: string;
	readonly outputPad: number;
	/** The markdown theme with the user's code block indent applied. */
	getMarkdownTheme(): MarkdownTheme;
	getRegisteredToolDefinition(toolName: string): ReturnType<AgentSession["getToolDefinition"]>;
	getUserMessageText(message: Message): string;
	addToolComponentToChat(component: ToolExecutionComponent): void;
	renderProjectTrustWarningIfNeeded(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	updateEditorBorderColor(): void;
}

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }>;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

export function addCustomEntryToChat(host: ChatHistoryHost, entry: Extract<SessionEntry, { type: "custom" }>): void {
	const renderer = host.session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) {
		return;
	}
	const component = new CustomEntryComponent(entry, renderer);
	component.setExpanded(host.toolOutputExpanded);
	if (!component.hasContent()) {
		return;
	}

	if (host.streamingComponent) {
		const streamingIndex = host.chatContainer.children.indexOf(host.streamingComponent);
		if (streamingIndex >= 0) {
			host.chatContainer.children.splice(streamingIndex, 0, component);
			return;
		}
	}

	host.chatContainer.addChild(component);
}

export function addMessageToChat(
	host: ChatHistoryHost,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
): void {
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(message.command, host.ui, message.excludeFromContext);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
			);
			host.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (message.display) {
				const renderer = host.session.extensionRunner.getMessageRenderer(message.customType);
				const component = new CustomMessageComponent(message, renderer, host.getMarkdownTheme());
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
			}
			break;
		}
		case "compactionSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new CompactionSummaryMessageComponent(message, host.getMarkdownTheme());
			component.setExpanded(host.toolOutputExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "branchSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(message, host.getMarkdownTheme());
			component.setExpanded(host.toolOutputExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "user": {
			const textContent = host.getUserMessageText(message);
			if (textContent) {
				if (host.chatContainer.children.length > 0) {
					host.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				// lunr: render injected prompts (/research /goal) collapsed instead
				// of dumping the full multi-line prompt body verbatim.
				const injected = detectInjectedPrompt(textContent);
				if (injected) {
					const component = new InjectedPromptMessageComponent(
						injected.kind,
						injected.summary,
						textContent,
						host.getMarkdownTheme(),
					);
					component.setExpanded(host.toolOutputExpanded);
					host.chatContainer.addChild(component);
				} else if (skillBlock) {
					// Render skill block (collapsible)
					const component = new SkillInvocationMessageComponent(skillBlock, host.getMarkdownTheme());
					component.setExpanded(host.toolOutputExpanded);
					host.chatContainer.addChild(component);
					// Render user message separately if present
					if (skillBlock.userMessage) {
						host.chatContainer.addChild(new Spacer(1));
						const userComponent = new UserMessageComponent(
							skillBlock.userMessage,
							host.getMarkdownTheme(),
							host.outputPad,
						);
						host.chatContainer.addChild(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(textContent, host.getMarkdownTheme(), host.outputPad);
					host.chatContainer.addChild(userComponent);
				}
				if (options?.populateHistory) {
					host.editor.addToHistory?.(textContent);
				}
			}
			break;
		}
		case "assistant": {
			const assistantComponent = new AssistantMessageComponent(
				message,
				host.hideThinkingBlock,
				host.getMarkdownTheme(),
				host.hiddenThinkingLabel,
				host.outputPad,
				host.thinkingCollapse,
				{
					requestRender: () => host.ui.requestRender(),
					reasoningDisplay: host.settingsManager.getReasoningDisplay(),
				},
			);
			// lunr: collapsible reasoning — re-attach live timings when this
			// message was streamed in this session (undefined = history).
			assistantComponent.setThinkingTimings(host.thinkingTimingsByMessage.get(message));
			// lunr: ctrl+o expansion — inherit the global expand state.
			assistantComponent.setExpanded(host.toolOutputExpanded);
			host.chatContainer.addChild(assistantComponent);
			break;
		}
		case "toolResult": {
			// Tool results are rendered inline with tool calls, handled separately
			break;
		}
		default: {
			const _exhaustive: never = message;
		}
	}
}

export function renderSessionItems(
	host: ChatHistoryHost,
	items: readonly RenderSessionItem[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	host.pendingTools.clear();
	let browserActivityComponent: ToolExecutionComponent | undefined;
	const renderedPendingTools = new Map<string, ToolExecutionComponent>();
	// Cache-miss notices are not persisted; re-derive them from the full entry
	// list and re-inject them after the assistant messages that paid for them.
	const cacheMisses = host.settingsManager.getShowCacheMissNotices()
		? collectCacheMisses(host.sessionManager.getEntries(), host.session.modelRuntime)
		: new Map<AssistantMessage, CacheMiss>();

	if (options.updateFooter) {
		host.footer.invalidate();
		host.updateEditorBorderColor();
	}

	for (const item of items) {
		if (isCustomSessionEntry(item)) {
			addCustomEntryToChat(host, item);
			continue;
		}

		const message = item;
		// Assistant messages need special handling for tool calls
		if (message.role === "assistant") {
			addMessageToChat(host, message);
			// Render tool call components
			for (const content of message.content) {
				if (content.type === "toolCall") {
					let component = content.name === "browser" ? browserActivityComponent : undefined;
					if (component) {
						component.beginNextExecution(content.id, content.arguments);
					} else {
						component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: host.settingsManager.getShowImages(),
								imageWidthCells: host.settingsManager.getImageWidthCells(),
							},
							host.getRegisteredToolDefinition(content.name),
							host.ui,
							host.sessionManager.getCwd(),
						);
						component.setExpanded(host.toolOutputExpanded);
						host.addToolComponentToChat(component);
						if (content.name === "browser") browserActivityComponent = component;
					}

					if (message.stopReason === "aborted" || message.stopReason === "error") {
						let errorMessage: string;
						if (message.stopReason === "aborted") {
							const retryAttempt = host.session.retryAttempt;
							errorMessage =
								retryAttempt > 0
									? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted";
						} else {
							errorMessage = message.errorMessage || "Error";
						}
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
			}
			if (message.stopReason !== "aborted" && message.stopReason !== "error") {
				const miss = cacheMisses.get(message);
				if (miss) addCacheMissNotice(host, miss);
			}
		} else if (message.role === "toolResult") {
			// Match tool results to pending tool components
			const component = renderedPendingTools.get(message.toolCallId);
			if (component) {
				component.updateResult(message);
				renderedPendingTools.delete(message.toolCallId);
			}
		} else {
			if (message.role === "user") browserActivityComponent = undefined;
			// All other messages use standard rendering
			addMessageToChat(host, message, options);
		}
	}

	for (const [toolCallId, component] of renderedPendingTools) {
		host.pendingTools.set(toolCallId, component);
	}
	host.ui.requestRender();
}

/**
 * Render session entries to chat. Used for initial load and rebuild after compaction.
 * @param entries Compaction-aware session entries to render
 * @param options.updateFooter Update footer state
 * @param options.populateHistory Add user messages to editor history
 */
export function renderSessionEntries(
	host: ChatHistoryHost,
	entries: SessionEntry[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	const items = entries.flatMap((entry): RenderSessionItem[] => {
		if (entry.type === "custom") {
			return [entry];
		}
		return sessionEntryToContextMessages(entry);
	});
	renderSessionItems(host, items, options);
}

/**
 * Show a transcript notice when a completed assistant message paid for a
 * significant cache miss. The overlap estimate cannot establish identical prompt content. It also shows
 * a model switch, or an idle gap past the cache TTL.
 */
export function maybeShowCacheMissNotice(host: ChatHistoryHost, message: AssistantMessage): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;

	// Entries don't contain `message` yet: message_end fires before persistence.
	const miss = detectCacheMiss(host.sessionManager.getEntries(), message, host.session.modelRuntime);
	if (miss) addCacheMissNotice(host, miss);
}

/** Warns when a Claude subscription session first grows past what Claude Code can send prompt-cached. */
export function maybeShowHistoryReplayNotice(host: ChatHistoryHost, message: AssistantMessage): void {
	if (!claudeCodeHistoryReplayed(message)) return;
	// Entries don't contain `message` yet: message_end fires before persistence.
	const entries = host.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (claudeCodeHistoryReplayed(entry.message)) return;
		break;
	}
	host.showWarning(CLAUDE_CODE_HISTORY_REPLAYED_NOTE);
}

export function addCacheMissNotice(host: ChatHistoryHost, miss: CacheMiss): void {
	if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

	const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
	const reBilled = `~${formatTokens(miss.missedTokens)} tokens may have missed cache${cost}`;
	let label = "Estimated cache miss";
	if (miss.modelChanged) {
		label = "Estimated cache miss after model switch";
	} else if (miss.idleMs >= CACHE_TTL_MS) {
		label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
	}
	const text = theme.fg("warning", `${label}: ${reBilled}`);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(text, 1, 0));
}

export function renderInitialMessages(host: ChatHistoryHost): void {
	const entries = host.sessionManager.buildContextEntries();
	renderSessionEntries(host, entries, {
		updateFooter: true,
		populateHistory: true,
	});
	host.renderProjectTrustWarningIfNeeded();

	// Show compaction info if session was compacted
	const allEntries = host.sessionManager.getEntries();
	const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
	if (compactionCount > 0) {
		const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
		host.showStatus(`Session compacted ${times}`);
	}
}
