/**
 * /help and /hotkeys for interactive mode: the short help block and the full keyboard shortcut
 * table, including extension shortcuts, printed into the chat. InteractiveMode supplies the
 * chat and keybindings through HelpCommandHost.
 */

import { type Container, Markdown, type MarkdownTheme, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { formatKeyText, keyDisplayText } from "./components/keybinding-hints.ts";
import { buildHelpLines } from "./slash-guidance.ts";
import { theme } from "./theme/theme.ts";

/** What /help and /hotkeys need from InteractiveMode. InteractiveMode builds one in `createChatViewHost`. */
export interface HelpCommandHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly keybindings: KeybindingsManager;
	/** The markdown theme with the user's code block indent applied. */
	getMarkdownTheme(): MarkdownTheme;
}

/** Prints the short /help block: the commands and keys a new user needs first. */
export function handleHelpCommand(host: HelpCommandHost): void {
	const lines = buildHelpLines(
		{
			cyclePermissionMode: keyDisplayText("app.mode.cycle"),
			interrupt: keyDisplayText("app.interrupt"),
		},
		(title) => theme.bold(theme.fg("accent", title)),
	);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}

export function handleHotkeysCommand(host: HelpCommandHost): void {
	// Navigation keybindings
	const cursorUp = keyDisplayText("tui.editor.cursorUp");
	const cursorDown = keyDisplayText("tui.editor.cursorDown");
	const cursorLeft = keyDisplayText("tui.editor.cursorLeft");
	const cursorRight = keyDisplayText("tui.editor.cursorRight");
	const cursorWordLeft = keyDisplayText("tui.editor.cursorWordLeft");
	const cursorWordRight = keyDisplayText("tui.editor.cursorWordRight");
	const cursorLineStart = keyDisplayText("tui.editor.cursorLineStart");
	const cursorLineEnd = keyDisplayText("tui.editor.cursorLineEnd");
	const jumpForward = keyDisplayText("tui.editor.jumpForward");
	const jumpBackward = keyDisplayText("tui.editor.jumpBackward");
	const pageUp = keyDisplayText("tui.editor.pageUp");
	const pageDown = keyDisplayText("tui.editor.pageDown");

	// Editing keybindings
	const submit = keyDisplayText("tui.input.submit");
	const newLine = keyDisplayText("tui.input.newLine");
	const deleteWordBackward = keyDisplayText("tui.editor.deleteWordBackward");
	const deleteWordForward = keyDisplayText("tui.editor.deleteWordForward");
	const deleteToLineStart = keyDisplayText("tui.editor.deleteToLineStart");
	const deleteToLineEnd = keyDisplayText("tui.editor.deleteToLineEnd");
	const yank = keyDisplayText("tui.editor.yank");
	const yankPop = keyDisplayText("tui.editor.yankPop");
	const undo = keyDisplayText("tui.editor.undo");
	const tab = keyDisplayText("tui.input.tab");

	// App keybindings
	const interrupt = keyDisplayText("app.interrupt");
	const clear = keyDisplayText("app.clear");
	const exit = keyDisplayText("app.exit");
	const suspend = keyDisplayText("app.suspend");
	const cycleThinkingLevel = keyDisplayText("app.thinking.cycle");
	const cyclePermissionMode = keyDisplayText("app.mode.cycle");
	const cycleModelForward = keyDisplayText("app.model.cycleForward");
	const selectModel = keyDisplayText("app.model.select");
	const expandTools = "click";
	const toggleThinking = keyDisplayText("app.thinking.toggle");
	const externalEditor = keyDisplayText("app.editor.external");
	const cycleModelBackward = keyDisplayText("app.model.cycleBackward");
	const copyMessage = keyDisplayText("app.message.copy");
	const followUp = keyDisplayText("app.message.followUp");
	const dequeue = keyDisplayText("app.message.dequeue");
	const pasteImage = keyDisplayText("app.clipboard.pasteImage");

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |
| Mouse wheel | Scroll session (Ctrl+wheel pages) |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` twice | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cyclePermissionMode}\` | Cycle permission mode |
${cycleThinkingLevel ? `| \`${cycleThinkingLevel}\` | Cycle thinking level |\n` : ""}| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Expand or collapse a thinking/tool card |
${toggleThinking ? `| \`${toggleThinking}\` | Toggle thinking block visibility |\n` : ""}| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image or text from clipboard |
| \`/paste-image\` | Paste image without a terminal shortcut |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

	// Add extension-registered shortcuts
	const extensionRunner = host.session.extensionRunner;
	const shortcuts = extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [key, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			const keyDisplay = formatKeyText(key, { capitalize: true });
			hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
		}
	}

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, host.getMarkdownTheme()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}
