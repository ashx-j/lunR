/**
 * Web access (web_search / fetch_content / get_search_content + the browser
 * search curator) — absorbed from the former pi-web-access baked-in extension
 * into core.
 *
 * `extension.ts` is the moved upstream file (kept `// @ts-nocheck`, biome-excluded)
 * with only these changes:
 *   - `@earendil-works/pi-coding-agent` imports -> relative core type imports.
 *   - The `@lunr/search-curator` globalThis bridge deleted; the workflow get/set
 *     is exported directly (getSearchCuratorWorkflow/setSearchCuratorWorkflow).
 *   - Shortcut key resolution exported (getWebAccessShortcutKeys).
 *
 * This module is the composition root. It runs the moved default factory once
 * with a host adapter shaped like the old `pi: ExtensionAPI` surface and
 * captures the registrations:
 *   - Tools (`web_search`, `fetch_content`, `get_search_content`) are customTools
 *     assembled in main.ts. Their execute ctx still comes from the session's
 *     extension runner (full ExtensionContext), unchanged.
 *   - Commands (/websearch, /curator, /google-account, /search) are built-in
 *     slash commands dispatched by InteractiveMode.
 *   - Shortcuts (curate: ctrl+shift+s, activity: ctrl+shift+w) are handled
 *     directly by InteractiveMode's onExtensionShortcut wiring.
 *   - Lifecycle: session_start/session_tree -> onSessionChange (driven from
 *     InteractiveMode.rebindCurrentSession and the session_tree emit site in
 *     agent-session.ts), session_shutdown -> onSessionShutdown (driven from
 *     InteractiveMode's invalidate callback and AgentSession.reload).
 *
 * The host's session-touching methods (appendEntry/sendMessage) delegate to the
 * CURRENT session via deps.getSession() so session replacement keeps working.
 * `exec` (browser open) runs through node child_process directly.
 */

import { execFile } from "node:child_process";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import registerWebAccess, {
	getSearchCuratorWorkflow,
	getWebAccessShortcutKeys,
	setSearchCuratorWorkflow,
	type WebSearchWorkflow,
} from "./extension.ts";

// --- Deps + UI surface ---

/**
 * UI primitives the feature needs from its host (activity widget, notify,
 * selector dialogs, theme). InteractiveMode provides these; before that (and
 * in non-interactive modes) the UI-dependent parts no-op, matching an unloaded
 * extension.
 */
export interface WebAccessUi {
	readonly theme: Theme;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	/** The moved code passes a constructed component (or undefined to clear). */
	setWidget: (key: string, content: Component | undefined) => void;
}

/**
 * Session/UI access. InteractiveMode configures these with getters that follow
 * session replacement; before that, session-dependent parts no-op.
 */
export interface WebAccessFeatureDeps {
	getSession?: () => AgentSession | undefined;
	getUi?: () => WebAccessUi | undefined;
}

interface WebAccessCommand {
	description: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface WebAccessShortcut {
	description: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
}

type WebAccessEventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

/** No-op UI for contexts built without an InteractiveMode host (non-interactive
 * modes). Only session state is touched there; the widget/notify paths are
 * unreachable because the widget can only be enabled via a UI shortcut. */
const noUi: WebAccessUi = {
	get theme(): Theme {
		throw new Error("web-access UI is not configured");
	},
	notify: () => {},
	select: () => Promise.resolve(undefined),
	setWidget: () => {},
};

/** Replacement for the old pi.exec (used by openInBrowser). */
function execCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execFile(command, args, (error, stdout, stderr) => {
			resolve({
				stdout: stdout ?? "",
				stderr: stderr ?? "",
				code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
			});
		});
	});
}

export class WebAccessFeature {
	private deps: WebAccessFeatureDeps;
	readonly tools: ToolDefinition[] = [];
	private readonly commands = new Map<string, WebAccessCommand>();
	private readonly shortcuts = new Map<string, WebAccessShortcut>();
	/** session_start + session_tree handlers (both are handleSessionChange). */
	private readonly changeHandlers: WebAccessEventHandler[] = [];
	private readonly shutdownHandlers: WebAccessEventHandler[] = [];

	constructor(deps: WebAccessFeatureDeps = {}) {
		this.deps = deps;
		// Run the moved extension factory once, capturing its registrations.
		// All mutable state in extension.ts is module-level (same as before).
		registerWebAccess(this.createHost());
	}

	/** Merge new host capabilities (InteractiveMode (re)configures on startup). */
	configure(deps: WebAccessFeatureDeps): void {
		this.deps = { ...this.deps, ...deps };
	}

	/**
	 * Adapter for the moved factory's `pi` surface. register* calls are captured;
	 * session-touching methods delegate to the current session at call time and
	 * are fire-and-forget (the old ExtensionAPI reported delivery failures
	 * through the error listener; here they go to the host's notify).
	 */
	private createHost(): ExtensionAPI {
		const feature = this;
		const notifyError = (prefix: string, error: unknown) => {
			feature.deps.getUi?.()?.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
		};
		const host = {
			registerTool(definition: ToolDefinition) {
				feature.tools.push(definition);
			},
			registerCommand(name: string, command: WebAccessCommand) {
				feature.commands.set(name, command);
			},
			registerShortcut(key: string, shortcut: WebAccessShortcut) {
				feature.shortcuts.set(key, shortcut);
			},
			on(event: string, handler: WebAccessEventHandler) {
				if (event === "session_shutdown") feature.shutdownHandlers.push(handler);
				else feature.changeHandlers.push(handler);
			},
			appendEntry(customType: string, data?: unknown) {
				feature.deps.getSession?.()?.appendCustomEntry(customType, data);
			},
			sendMessage(
				message: Parameters<AgentSession["sendCustomMessage"]>[0],
				options?: Parameters<AgentSession["sendCustomMessage"]>[1],
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session.sendCustomMessage(message, options).catch((error) => notifyError("Web access message failed", error));
			},
			exec(command: string, args: string[]) {
				return execCommand(command, args);
			},
		};
		return host as unknown as ExtensionAPI;
	}

	/**
	 * ExtensionContext equivalent of the old extension ctx: session-derived state
	 * plus the UI primitives injected by the host. Undefined when no session is
	 * bound (callers no-op, same as an unloaded extension). Without a configured
	 * UI the ctx carries no-op UI primitives so session-state lifecycle work
	 * (stored-result restore) still runs in non-interactive modes.
	 */
	private makeCtx(): ExtensionContext | undefined {
		const session = this.deps.getSession?.();
		if (!session) return undefined;
		const ui = this.deps.getUi?.() ?? noUi;
		return {
			ui,
			mode: "tui",
			hasUI: ui !== noUi,
			cwd: session.sessionManager.getCwd(),
			sessionManager: session.sessionManager,
			modelRegistry: new ModelRegistry(session.modelRuntime),
			model: session.model,
			isProjectTrusted: () => session.settingsManager.isProjectTrusted(),
		} as unknown as ExtensionContext;
	}

	// =========================================================================
	// Commands (formerly pi.registerCommand — /websearch, /curator,
	// /google-account, /search). Dispatched by InteractiveMode.
	// =========================================================================

	async handleCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		await command.handler(args, ctx);
	}

	// =========================================================================
	// Shortcuts (formerly pi.registerShortcut — curate + activity keys). Key
	// matching happens in InteractiveMode's onExtensionShortcut wiring.
	// =========================================================================

	getShortcutKeys(): { curate: string; activity: string } {
		return getWebAccessShortcutKeys();
	}

	async handleCurateShortcut(): Promise<void> {
		await this.runShortcut(getWebAccessShortcutKeys().curate);
	}

	async handleActivityShortcut(): Promise<void> {
		await this.runShortcut(getWebAccessShortcutKeys().activity);
	}

	private async runShortcut(key: string): Promise<void> {
		const shortcut = this.shortcuts.get(key);
		if (!shortcut) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		await shortcut.handler(ctx);
	}

	// =========================================================================
	// Session lifecycle (formerly pi.on("session_start"/"session_tree"/
	// "session_shutdown")). Driven from InteractiveMode + agent-session.ts.
	// =========================================================================

	/** session_start + session_tree (both were handleSessionChange). */
	onSessionChange(): void {
		const ctx = this.makeCtx();
		if (!ctx) return;
		for (const handler of this.changeHandlers) {
			Promise.resolve(handler(undefined, ctx)).catch((error) => {
				this.deps
					.getUi?.()
					?.notify(
						`Web access session change failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
			});
		}
	}

	onSessionShutdown(): void {
		for (const handler of this.shutdownHandlers) {
			try {
				handler(undefined, undefined as unknown as ExtensionContext);
			} catch (error) {
				this.deps
					.getUi?.()
					?.notify(
						`Web access session shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
			}
		}
	}
}

// =========================================================================
// Process-wide singleton (the extension was a per-process factory singleton).
// =========================================================================

let currentWebAccessFeature: WebAccessFeature | undefined;

/**
 * Create (or reconfigure) the process-wide web-access feature. main.ts calls
 * this with no deps so the tools always exist; InteractiveMode calls it with
 * TUI deps (widget/notify/select/theme + current-session getter).
 */
export function createWebAccessFeature(deps: WebAccessFeatureDeps = {}): WebAccessFeature {
	if (!currentWebAccessFeature) {
		currentWebAccessFeature = new WebAccessFeature(deps);
	} else {
		currentWebAccessFeature.configure(deps);
	}
	return currentWebAccessFeature;
}

/** Current web-access feature, or undefined when none was created (tests, bare sessions). */
export function getWebAccessFeature(): WebAccessFeature | undefined {
	return currentWebAccessFeature;
}

/** Web-access tools for the customTools assembly in main.ts. */
export function createWebAccessTools(): ToolDefinition[] {
	return createWebAccessFeature().tools;
}

// =========================================================================
// Search curator setting (formerly the @lunr/search-curator bridge consumer in
// core/search-curator.ts). The feature is always present now, so the /settings
// "Search curator" row always works; state lives in web-search.json via the
// feature's own saveConfig (single source of truth, same as /curator).
// =========================================================================

/** UI-level setting values exposed in /settings (map to web-access workflows). */
export type SearchCuratorSetting = "off" | "on" | "auto-summary";

/** Current curator setting for the /settings row. */
export function getSearchCuratorSetting(): SearchCuratorSetting {
	const workflow = getSearchCuratorWorkflow();
	if (workflow === "none") return "off";
	if (workflow === "auto-summary") return "auto-summary";
	return "on";
}

/** Write a curator setting through the feature's own config path (web-search.json). */
export function setSearchCuratorSetting(setting: SearchCuratorSetting): void {
	const workflow: WebSearchWorkflow =
		setting === "off" ? "none" : setting === "auto-summary" ? "auto-summary" : "summary-review";
	setSearchCuratorWorkflow(workflow);
}
