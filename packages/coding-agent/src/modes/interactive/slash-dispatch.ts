/**
 * Builtin slash command dispatch for interactive mode. The submit handler looks up the trimmed text with
 * `findSlashCommandHandler` and runs the match; InteractiveMode supplies its UI and commands through
 * SlashCommandHost. /reclaim and /handoff stay in the submit handler because they run before its
 * detached-session guard.
 */

import type { EditorComponent } from "@earendil-works/pi-tui";
import type { PermissionMode } from "../../core/permissions.ts";
import { handleLoginCommand, type LoginFlowHost } from "./login-flow.ts";

/** What builtin slash commands need from InteractiveMode. InteractiveMode builds one in `createSlashCommandHost`. */
export interface SlashCommandHost {
	readonly editor: EditorComponent;
	readonly loginFlowHost: LoginFlowHost;
	handleClipboardPaste(options: { textFallback?: boolean }): Promise<void>;
	showSettingsSelector(): Promise<void>;
	showModelsSelector(): Promise<void>;
	handleModelCommand(searchTerm?: string): Promise<void>;
	handleRefreshCommand(): Promise<void>;
	handleExportCommand(text: string): Promise<void>;
	handleImportCommand(text: string): Promise<void>;
	handleCopyCommand(): Promise<void>;
	handleNameCommand(text: string): void;
	handleSessionCommand(): void;
	handleUsageCommand(): Promise<void>;
	handleFastCommand(arg: string): void;
	handleContextCommand(): void;
	handlePlanCommand(args: string): Promise<void>;
	handleHotkeysCommand(): void;
	handleHelpCommand(): void;
	showUserMessageSelector(): void;
	handleCloneCommand(): Promise<void>;
	showTreeSelector(): void;
	handleUndoCommand(): Promise<void>;
	handleEditCommand(): Promise<void>;
	handleRedoCommand(): Promise<void>;
	handleModeCommand(args: string): void;
	applyPermissionMode(mode: PermissionMode): void;
	showProcessesSelector(): void;
	handleRollbackCommand(): Promise<void>;
	showTrustSelector(): void;
	showOAuthSelector(mode: "login" | "logout"): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<void>;
	handleReloadCommand(): Promise<void>;
	handleInitCommand(): Promise<void>;
	handleDebugCommand(): void;
	showSessionSelector(): void;
	shutdown(): Promise<void>;
}

export interface SlashCommandHandler {
	/** Also matches `/name <args>` (first space). Without it only the bare `/name` matches. */
	readonly takesArgs?: boolean;
	/** `text` is the trimmed submitted text; each handler parses its own arguments from it. */
	run(host: SlashCommandHost, text: string): Promise<void> | void;
}

// One entry per command, aliases listed with it.
const HANDLERS: ReadonlyArray<SlashCommandHandler & { readonly names: readonly string[] }> = [
	{
		names: ["paste-image"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleClipboardPaste({ textFallback: false });
		},
	},
	{
		names: ["settings"],
		run: (host) => {
			void host.showSettingsSelector();
			host.editor.setText("");
		},
	},
	{
		names: ["scoped-models"],
		run: async (host) => {
			host.editor.setText("");
			await host.showModelsSelector();
		},
	},
	{
		names: ["model"],
		takesArgs: true,
		run: async (host, text) => {
			const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
			host.editor.setText("");
			await host.handleModelCommand(searchTerm);
		},
	},
	{
		names: ["refresh"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleRefreshCommand();
		},
	},
	{
		names: ["export"],
		takesArgs: true,
		run: async (host, text) => {
			await host.handleExportCommand(text);
			host.editor.setText("");
		},
	},
	{
		names: ["import"],
		takesArgs: true,
		run: async (host, text) => {
			await host.handleImportCommand(text);
			host.editor.setText("");
		},
	},
	{
		names: ["copy"],
		run: async (host) => {
			await host.handleCopyCommand();
			host.editor.setText("");
		},
	},
	{
		names: ["name", "title"],
		takesArgs: true,
		run: (host, text) => {
			host.handleNameCommand(text);
			host.editor.setText("");
		},
	},
	{
		names: ["session"],
		run: (host) => {
			host.handleSessionCommand();
			host.editor.setText("");
		},
	},
	{
		names: ["usage"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleUsageCommand();
		},
	},
	{
		names: ["fast"],
		takesArgs: true,
		run: (host, text) => {
			host.editor.setText("");
			host.handleFastCommand(text === "/fast" ? "" : text.slice(6).trim());
		},
	},
	{
		names: ["context"],
		run: (host) => {
			host.editor.setText("");
			host.handleContextCommand();
		},
	},
	{
		names: ["plan"],
		takesArgs: true,
		run: async (host, text) => {
			host.editor.setText("");
			await host.handlePlanCommand(text === "/plan" ? "" : text.slice(6).trim());
		},
	},
	{
		names: ["hotkeys"],
		run: (host) => {
			host.handleHotkeysCommand();
			host.editor.setText("");
		},
	},
	{
		names: ["help"],
		run: (host) => {
			host.handleHelpCommand();
			host.editor.setText("");
		},
	},
	{
		names: ["fork"],
		run: (host) => {
			host.showUserMessageSelector();
			host.editor.setText("");
		},
	},
	{
		names: ["clone"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleCloneCommand();
		},
	},
	{
		names: ["tree"],
		run: (host) => {
			host.showTreeSelector();
			host.editor.setText("");
		},
	},
	{
		names: ["undo"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleUndoCommand();
		},
	},
	{
		names: ["edit"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleEditCommand();
		},
	},
	{
		names: ["redo"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleRedoCommand();
		},
	},
	{
		names: ["mode"],
		takesArgs: true,
		run: (host, text) => {
			host.editor.setText("");
			host.handleModeCommand(text === "/mode" ? "" : text.slice(6).trim());
		},
	},
	{
		names: ["read", "yolo", "auto"],
		run: (host, text) => {
			host.editor.setText("");
			host.applyPermissionMode(text === "/read" ? "read-only" : (text.slice(1) as PermissionMode));
		},
	},
	{
		names: ["processes"],
		run: (host) => {
			host.editor.setText("");
			host.showProcessesSelector();
		},
	},
	{
		names: ["rollback"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleRollbackCommand();
		},
	},
	{
		names: ["trust"],
		run: (host) => {
			host.showTrustSelector();
			host.editor.setText("");
		},
	},
	{
		names: ["login", "auth"],
		takesArgs: true,
		run: async (host, text) => {
			// lunr: /auth is an alias of /login; the provider arg follows the first space.
			const providerRef = text.includes(" ") ? text.slice(text.indexOf(" ") + 1).trim() : undefined;
			host.editor.setText("");
			await handleLoginCommand(host.loginFlowHost, providerRef);
		},
	},
	{
		names: ["logout", "deauth"],
		run: (host) => {
			// lunr: /deauth is an alias of /logout.
			host.showOAuthSelector("logout");
			host.editor.setText("");
		},
	},
	{
		names: ["new"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleClearCommand();
		},
	},
	{
		names: ["compact"],
		takesArgs: true,
		run: async (host, text) => {
			const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
			host.editor.setText("");
			await host.handleCompactCommand(customInstructions);
		},
	},
	{
		names: ["reload"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleReloadCommand();
		},
	},
	{
		names: ["init"],
		run: async (host) => {
			host.editor.setText("");
			await host.handleInitCommand();
		},
	},
	{
		names: ["debug"],
		run: (host) => {
			host.handleDebugCommand();
			host.editor.setText("");
		},
	},
	{
		names: ["resume", "sessions"],
		run: (host) => {
			host.showSessionSelector();
			host.editor.setText("");
		},
	},
	{
		names: ["quit", "exit"],
		run: async (host) => {
			// lunr: /exit is an alias of /quit.
			host.editor.setText("");
			await host.shutdown();
		},
	},
];

/** Builtin slash command handlers keyed by command name, aliases included. */
export const SLASH_COMMAND_HANDLERS: ReadonlyMap<string, SlashCommandHandler> = new Map(
	HANDLERS.flatMap((handler) => handler.names.map((name) => [name, handler] as const)),
);

/**
 * Returns the handler for trimmed submitted `text`, or undefined when no builtin matches. The name runs
 * from after the `/` to the first space, so `/model x` finds `model` and `/modelx` finds nothing. Text
 * with arguments matches only handlers that take them; `/settings foo` falls through to the
 * unknown-command check and the prompt path.
 */
export function findSlashCommandHandler(text: string): SlashCommandHandler | undefined {
	if (!text.startsWith("/")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const handler = SLASH_COMMAND_HANDLERS.get(spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex));
	return handler && (spaceIndex === -1 || handler.takesArgs) ? handler : undefined;
}
