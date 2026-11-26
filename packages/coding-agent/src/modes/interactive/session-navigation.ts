/**
 * Moving within and between sessions in interactive mode: /tree, /fork (the user message
 * picker), /clone, /resume and its session picker, and /undo, /edit and /redo. InteractiveMode
 * supplies the session, runtime and UI through SessionNavigationHost.
 */

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { type Component, type Container, type EditorComponent, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionCommandContext, ProjectTrustContext } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { BranchSummaryStatusIndicator, type StatusIndicator } from "./components/status-indicator.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";

/** What session navigation needs from InteractiveMode. InteractiveMode builds one in `createSessionNavigationHost`. */
export interface SessionNavigationHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly runtimeHost: AgentSessionRuntime;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly keybindings: KeybindingsManager;
	readonly editor: EditorComponent;
	/** The built-in editor; the tree selector borrows its Escape handler while a branch summary runs. */
	readonly defaultEditor: CustomEditor;
	/** Leaf ids /undo and /edit left, newest last. /redo pops it; a new user message or /rollback empties it. */
	readonly redoStack: string[];
	/** True while the session is detached or being transferred. */
	isSessionDetached(): boolean;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
	showStatusIndicator(indicator: StatusIndicator): void;
	clearStatusIndicator(kind?: StatusIndicator["kind"]): void;
	/** Disposes the chat's tool cards and empties it. */
	clearChatContainer(): void;
	/** Draws the chat from the session's current branch. */
	renderInitialMessages(): void;
	restoreEditorFromTreeResult(result: { editorText?: string; editorImages?: ImageContent[] }): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	createProjectTrustContext(cwd: string): ProjectTrustContext;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	shutdown(): Promise<void>;
}

export function showUserMessageSelector(host: SessionNavigationHost): void {
	if (host.isSessionDetached()) return;
	const userMessages = host.session.getUserMessagesForForking();

	if (userMessages.length === 0) {
		host.showStatus("No messages to fork from");
		return;
	}

	const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

	host.showSelector((done) => {
		const selector = new UserMessageSelectorComponent(
			userMessages.map((m) => ({ id: m.entryId, text: m.text })),
			async (entryId) => {
				done();
				try {
					const result = await host.runtimeHost.fork(entryId);
					if (result.cancelled) {
						host.ui.requestRender();
						return;
					}

					host.editor.setText(result.selectedText ?? "");
					host.showStatus("Forked to new session");
				} catch (error: unknown) {
					host.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			initialSelectedId,
		);
		return { component: selector, focus: selector.getMessageList() };
	});
}

export async function handleCloneCommand(host: SessionNavigationHost): Promise<void> {
	const leafId = host.sessionManager.getLeafId();
	if (!leafId) {
		host.showStatus("Nothing to clone yet");
		return;
	}

	try {
		const result = await host.runtimeHost.fork(leafId, { position: "at" });
		if (result.cancelled) {
			host.ui.requestRender();
			return;
		}

		host.editor.setText("");
		host.showStatus("Cloned to new session");
	} catch (error: unknown) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export function showTreeSelector(host: SessionNavigationHost, initialSelectedId?: string): void {
	if (host.isSessionDetached()) return;
	if (host.session.isStreaming) {
		host.showWarning("Wait for the current response to finish before running /tree.");
		return;
	}
	const tree = host.sessionManager.getTree();
	const realLeafId = host.sessionManager.getLeafId();
	const initialFilterMode = host.settingsManager.getTreeFilterMode();

	if (tree.length === 0) {
		host.showStatus("No entries in session");
		return;
	}

	host.showSelector((done) => {
		const selector = new TreeSelectorComponent(
			tree,
			realLeafId,
			host.ui.terminal.rows,
			async (entryId) => {
				// Selecting the current leaf is a no-op (already there)
				if (entryId === realLeafId) {
					done();
					host.showStatus("Already at this point");
					return;
				}

				// Ask about summarization
				done(); // Close selector first

				// Loop until user makes a complete choice or cancels to tree
				let wantsSummary = false;
				let customInstructions: string | undefined;

				// Check if we should skip the prompt (user preference to always default to no summary)
				if (!host.settingsManager.getBranchSummarySkipPrompt()) {
					while (true) {
						const summaryChoice = await host.showExtensionSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector with same selection
							showTreeSelector(host, entryId);
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await host.showExtensionEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}
				}

				// Set up escape handler and status indicator if summarizing
				let showingSummaryIndicator = false;
				const originalOnEscape = host.defaultEditor.onEscape;

				if (wantsSummary) {
					host.defaultEditor.onEscape = () => {
						host.session.abortBranchSummary();
					};
					host.chatContainer.addChild(new Spacer(1));
					host.showStatusIndicator(new BranchSummaryStatusIndicator(host.ui));
					showingSummaryIndicator = true;
					host.ui.requestRender();
				}

				try {
					const result = await host.session.navigateTree(entryId, {
						summarize: wantsSummary,
						customInstructions,
					});

					if (result.aborted) {
						// Summarization aborted - re-show tree selector with same selection
						host.showStatus("Branch summarization cancelled");
						showTreeSelector(host, entryId);
						return;
					}
					if (result.cancelled) {
						host.showStatus("Navigation cancelled");
						return;
					}

					// Update UI
					host.clearChatContainer();
					host.renderInitialMessages();
					if (result.editorText && !host.editor.getText().trim()) {
						host.restoreEditorFromTreeResult(result);
					}
					host.showStatus("Navigated to selected point");
					void host.flushCompactionQueue({ willRetry: false });
				} catch (error) {
					host.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (showingSummaryIndicator) {
						host.clearStatusIndicator("branchSummary");
					}
					host.defaultEditor.onEscape = originalOnEscape;
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			(entryId, label) => {
				host.sessionManager.appendLabelChange(entryId, label);
				host.ui.requestRender();
			},
			initialSelectedId,
			initialFilterMode,
		);
		selector.onCopy = async (text) => {
			if (!text) {
				host.showError("Selected entry has no text to copy");
				return;
			}
			try {
				await copyToClipboard(text);
				host.showStatus("Copied selected message to clipboard");
			} catch (error) {
				host.showError(error instanceof Error ? error.message : String(error));
			}
		};
		return { component: selector, focus: selector };
	});
}

export function showSessionSelector(host: SessionNavigationHost): void {
	host.showSelector((done) => {
		const selector = new SessionSelectorComponent(
			(onProgress) =>
				SessionManager.list(host.sessionManager.getCwd(), host.sessionManager.getSessionDir(), onProgress),
			(onProgress) =>
				host.sessionManager.usesDefaultSessionDir()
					? SessionManager.listAll(onProgress)
					: SessionManager.listAll(host.sessionManager.getSessionDir(), onProgress),
			async (sessionPath) => {
				done();
				await handleResumeSession(host, sessionPath);
			},
			() => {
				done();
				host.ui.requestRender();
			},
			() => {
				void host.shutdown();
			},
			() => host.ui.requestRender(),
			{
				renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					if (sessionFilePath === host.sessionManager.getSessionFile() && !host.runtimeHost.isDetached) {
						host.sessionManager.appendSessionInfo(next);
						return;
					}
					const mgr = SessionManager.open(sessionFilePath);
					try {
						mgr.appendSessionInfo(next);
					} finally {
						mgr.dispose();
					}
				},
				showRenameHint: true,
				keybindings: host.keybindings,
			},

			host.sessionManager.getSessionFile(),
		);
		return { component: selector, focus: selector };
	});
}

export async function handleResumeSession(
	host: SessionNavigationHost,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	host.clearStatusIndicator();
	try {
		const result = await host.runtimeHost.switchSession(sessionPath, {
			withSession: options?.withSession,
			projectTrustContextFactory: (cwd) => host.createProjectTrustContext(cwd),
		});
		if (result.cancelled) {
			return result;
		}
		host.showStatus("Resumed session");
		return result;
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			const result = await host.runtimeHost.switchSession(sessionPath, {
				cwdOverride: selectedCwd,
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => host.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			host.showStatus("Resumed session in current cwd");
			return result;
		}
		return host.handleFatalRuntimeError("Failed to resume session", error);
	}
}

// lunr: /undo and /edit rewind the same session via navigateTree (no fork).
// /undo leaves the editor alone; /edit pastes the undone user text. /redo
// pops the previous leaf and navigates back.
async function rewindLastTurn(
	host: SessionNavigationHost,
	command: "undo" | "edit",
): Promise<{ editorText?: string; editorImages?: ImageContent[] } | undefined> {
	if (host.session.isStreaming) {
		host.showWarning(`Wait for the current response to finish before running /${command}.`);
		return undefined;
	}

	const nothingLabel = command === "undo" ? "Nothing to undo" : "Nothing to edit";
	const branch = host.sessionManager.getBranch();
	let lastUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			lastUserIndex = i;
			break;
		}
	}
	if (lastUserIndex === -1) {
		host.showStatus(nothingLabel);
		return undefined;
	}

	const lastUser = branch[lastUserIndex];
	const leafId = host.sessionManager.getLeafId();
	let targetId: string;
	if (lastUser.id === leafId) {
		if (!lastUser.parentId) {
			host.showStatus(nothingLabel);
			return undefined;
		}
		targetId = lastUser.parentId;
	} else {
		targetId = lastUser.id;
	}

	try {
		const result = await host.session.navigateTree(targetId, {});
		if (result.cancelled) {
			host.showStatus(command === "undo" ? "Undo cancelled" : "Edit cancelled");
			return undefined;
		}
		if (leafId) {
			host.redoStack.push(leafId);
		}
		host.clearChatContainer();
		host.renderInitialMessages();
		void host.flushCompactionQueue({ willRetry: false });
		return { editorText: result.editorText, editorImages: result.editorImages };
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

export async function handleUndoCommand(host: SessionNavigationHost): Promise<void> {
	const result = await rewindLastTurn(host, "undo");
	if (!result) return;
	host.showStatus("Conversation rewound. Files are unchanged; /rollback restores them. /redo to restore the turn.");
}

export async function handleEditCommand(host: SessionNavigationHost): Promise<void> {
	const result = await rewindLastTurn(host, "edit");
	if (!result) return;
	host.restoreEditorFromTreeResult({
		editorText: result.editorText ?? "",
		editorImages: result.editorImages,
	});
	host.showStatus("Editing last message. /redo to restore.");
}

export async function handleRedoCommand(host: SessionNavigationHost): Promise<void> {
	if (host.session.isStreaming) {
		host.showWarning("Wait for the current response to finish before running /redo.");
		return;
	}

	const targetId = host.redoStack.pop();
	if (!targetId) {
		host.showStatus("Nothing to redo");
		return;
	}

	try {
		const result = await host.session.navigateTree(targetId, {});
		if (result.cancelled) {
			host.redoStack.push(targetId);
			host.showStatus("Navigation cancelled");
			return;
		}
		host.clearChatContainer();
		host.renderInitialMessages();
		if (result.editorText && !host.editor.getText().trim()) {
			host.restoreEditorFromTreeResult(result);
		}
		host.showStatus("Redone");
		void host.flushCompactionQueue({ willRetry: false });
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}
