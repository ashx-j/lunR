/**
 * Subagents — absorbed from the former pi-subagents baked-in extension into
 * core (~49k lines, the largest absorption).
 *
 * `src/` is the moved upstream tree (kept `// @ts-nocheck`, biome-excluded)
 * with only these changes:
 *   - `@earendil-works/pi-coding-agent` imports -> relative core imports
 *     (keyText, getMarkdownTheme, createReadOnlyTools, convertToLlm,
 *     SessionManager + type-only ExtensionAPI/ExtensionContext/Theme).
 *   - The `@lunr/model-tiers` globalThis bridge reads replaced with direct
 *     `core/model-tiers.ts` imports (tool-description.ts, model-fallback.ts).
 *   - `src/runs/shared/subagent-prompt-runtime.ts` and
 *     `src/extension/fanout-child.ts` are still loaded as real extension files
 *     by CHILD processes (via --extension paths resolved next to this tree);
 *     they are unchanged extension code.
 *
 * This module is the composition root. It runs the moved default factory once
 * with a host adapter shaped like the old `pi: ExtensionAPI` surface and
 * captures the registrations:
 *   - Tools (`subagent` + `subagent_wait`) are customTools assembled in main.ts.
 *     Their execute ctx still comes from the session's extension runner (full
 *     ExtensionContext), unchanged.
 *   - Commands (/run, /chain, /run-chain, /parallel, /subagent-cost,
 *     /subagents-doctor, /subagents-fleet, /subagents-stop, /subagents-models,
 *     /subagents-profiles, /subagents-load-profile,
 *     /subagents-refresh-provider-models, /subagents-generate-profiles,
 *     /subagents-check-profile, /subagents-watchdog) are built-in slash commands
 *     dispatched by InteractiveMode through handleCommand().
 *   - The Ctrl+Alt+F fleet shortcut is matched directly by InteractiveMode's
 *     onExtensionShortcut composition.
 *   - Message renderers (slash results, notify, steering/control notices,
 *     watchdog warnings) are consulted by InteractiveMode when the session's
 *     extension runner has no renderer for a custom message type.
 *   - Lifecycle + agent events (session_start/session_shutdown/agent_end/
 *     turn_end/tool_result/before_agent_start/session_compact/
 *     session_before_switch/session_before_fork) are direct calls from
 *     agent-session.ts / agent-session-runtime.ts / InteractiveMode.
 *
 * `pi.events` is a facade over the CURRENT session's shared event bus (the
 * resource loader's bus, shared with the remaining real extensions —
 * pi-intercom and pi-prompt-template-model coordinate with subagents over it).
 * Subscriptions are tracked and re-bound on every session_start.
 *
 * The host's session-touching methods (sendMessage/setModel/getAllTools/...)
 * delegate to the CURRENT session via deps.getSession() so session replacement
 * keeps working. In child processes (PI_SUBAGENT_CHILD=1) the moved factory
 * returns early, so the feature captures nothing and every entry point no-ops.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { EventBus } from "../../core/event-bus.ts";
import { type ExecOptions, type ExecResult, execCommand } from "../../core/exec.ts";
import type {
	CompactOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	ExtensionUIContext,
	MessageRenderer,
	RegisteredCommand,
	SessionStartEvent,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import registerSubagents from "./src/extension/index.ts";

// --- Deps ---

/**
 * Session/UI access. main.ts configures getSession/getEvents for every mode at
 * session creation; InteractiveMode additionally configures getUi (the full
 * ExtensionUIContext) so command handlers and event flows get the same UI
 * surface the extension context had. Before that (and in bare test sessions)
 * session-dependent parts no-op, matching an unloaded extension.
 */
export interface SubagentsFeatureDeps {
	getSession?: () => AgentSession | undefined;
	getUi?: () => ExtensionUIContext | undefined;
	/** Current session's shared extension event bus (pi.events facade target). */
	getEvents?: () => EventBus | undefined;
}

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

interface CapturedShortcut {
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
}

interface BusSubscription {
	channel: string;
	handler: (data: unknown) => void;
	unsubscribe?: () => void;
}

/** No-op UI for contexts built without an InteractiveMode host (print/rpc/test).
 * The moved code guards UI flows on ctx.hasUI, so these are unreachable there. */
const noUi: ExtensionUIContext = {
	get theme(): ExtensionUIContext["theme"] {
		throw new Error("subagents UI is not configured");
	},
	notify: () => {},
	select: () => Promise.resolve(undefined),
	confirm: () => Promise.resolve(false),
	input: () => Promise.resolve(undefined),
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: () => Promise.resolve(undefined),
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: () => Promise.resolve(undefined),
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false, error: "subagents UI is not configured" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
} as unknown as ExtensionUIContext;

export class SubagentsFeature {
	private deps: SubagentsFeatureDeps;
	readonly tools: ToolDefinition[] = [];
	private readonly commands = new Map<string, CapturedCommand>();
	private readonly shortcuts = new Map<string, CapturedShortcut>();
	private readonly messageRenderers = new Map<string, MessageRenderer>();
	private readonly eventHandlers = new Map<string, ExtensionHandler<never>[]>();
	/** Live facade subscriptions, re-bound to the current session bus on session_start. */
	private busSubscriptions: BusSubscription[] = [];
	private boundBus: EventBus | undefined;

	constructor(deps: SubagentsFeatureDeps = {}) {
		this.deps = deps;
		// Run the moved extension factory once, capturing its registrations.
		// In child processes (PI_SUBAGENT_CHILD=1) the factory returns early and
		// nothing is captured — every feature entry point then no-ops.
		registerSubagents(this.createHost());
	}

	/** Merge new host capabilities (main.ts + InteractiveMode (re)configure). */
	configure(deps: SubagentsFeatureDeps): void {
		this.deps = { ...this.deps, ...deps };
	}

	// =========================================================================
	// Host adapter (the old `pi: ExtensionAPI` surface)
	// =========================================================================

	private createHost(): ExtensionAPI {
		const feature = this;
		const notifyError = (prefix: string, error: unknown) => {
			feature.deps
				.getUi?.()
				?.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
		};
		const currentBus = (): EventBus | undefined => feature.deps.getEvents?.();
		const events: EventBus = {
			emit(channel, data) {
				currentBus()?.emit(channel, data);
			},
			on(channel, handler) {
				const subscription: BusSubscription = { channel, handler };
				feature.busSubscriptions.push(subscription);
				subscription.unsubscribe = currentBus()?.on(channel, handler);
				return () => {
					subscription.unsubscribe?.();
					const index = feature.busSubscriptions.indexOf(subscription);
					if (index !== -1) feature.busSubscriptions.splice(index, 1);
				};
			},
		};
		const host = {
			events,
			on(event: string, handler: ExtensionHandler<never>) {
				const handlers = feature.eventHandlers.get(event) ?? [];
				handlers.push(handler);
				feature.eventHandlers.set(event, handlers);
			},
			registerTool(definition: ToolDefinition) {
				feature.tools.push(definition);
			},
			registerCommand(name: string, command: CapturedCommand) {
				feature.commands.set(name, command);
			},
			registerShortcut(key: string, shortcut: CapturedShortcut) {
				feature.shortcuts.set(key, shortcut);
			},
			registerMessageRenderer(customType: string, renderer: MessageRenderer) {
				feature.messageRenderers.set(customType, renderer);
			},
			registerEntryRenderer() {
				// The moved tree registers no entry renderers.
			},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			registerProvider() {},
			unregisterProvider() {},
			sendMessage(
				message: Parameters<AgentSession["sendCustomMessage"]>[0],
				options?: Parameters<AgentSession["sendCustomMessage"]>[1],
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session.sendCustomMessage(message, options).catch((error) => notifyError("Subagent message failed", error));
			},
			sendUserMessage(
				content: Parameters<AgentSession["sendUserMessage"]>[0],
				options?: { deliverAs?: "steer" | "followUp" },
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session.sendUserMessage(content, options).catch((error) => notifyError("Subagent prompt failed", error));
			},
			appendEntry(customType: string, data?: unknown) {
				feature.deps.getSession?.()?.appendCustomEntry(customType, data);
			},
			setSessionName(name: string) {
				feature.deps.getSession?.()?.setSessionName(name);
			},
			getSessionName(): string | undefined {
				return feature.deps.getSession?.()?.sessionManager.getSessionName();
			},
			setLabel(entryId: string, label: string | undefined) {
				feature.deps.getSession?.()?.sessionManager.appendLabelChange(entryId, label);
			},
			exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
				const cwd = options?.cwd ?? feature.deps.getSession?.()?.sessionManager.getCwd() ?? process.cwd();
				return execCommand(command, args, cwd, options);
			},
			getActiveTools(): string[] {
				return feature.deps.getSession?.()?.getActiveToolNames() ?? [];
			},
			getAllTools(): ReturnType<AgentSession["getAllTools"]> {
				return feature.deps.getSession?.()?.getAllTools() ?? [];
			},
			setActiveTools(toolNames: string[]) {
				feature.deps.getSession?.()?.setActiveToolsByName(toolNames);
			},
			getCommands() {
				return [];
			},
			async setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<boolean> {
				const session = feature.deps.getSession?.();
				if (!session) return false;
				if (!session.modelRuntime.hasConfiguredAuth(model.provider)) return false;
				await session.setModel(model);
				return true;
			},
			getThinkingLevel() {
				return feature.deps.getSession?.()?.thinkingLevel ?? "off";
			},
			setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]) {
				feature.deps.getSession?.()?.setThinkingLevel(level);
			},
		};
		return host as unknown as ExtensionAPI;
	}

	/**
	 * ExtensionContext equivalent of the old extension ctx: session-derived state
	 * plus the UI context injected by the host (InteractiveMode's full
	 * ExtensionUIContext). Undefined when no session is bound (callers no-op,
	 * same as an unloaded extension).
	 */
	private makeCtx(): ExtensionContext | undefined {
		const session = this.deps.getSession?.();
		if (!session) return undefined;
		const ui = this.deps.getUi?.() ?? noUi;
		return {
			ui,
			mode: ui === noUi ? "print" : "tui",
			hasUI: ui !== noUi,
			cwd: session.sessionManager.getCwd(),
			sessionManager: session.sessionManager,
			modelRegistry: new ModelRegistry(session.modelRuntime),
			model: session.model,
			isIdle: () => session.isIdle,
			isProjectTrusted: () => session.settingsManager.isProjectTrusted(),
			signal: session.agent.signal,
			abort: () => {
				void session.abort();
			},
			hasPendingMessages: () => session.pendingMessageCount > 0,
			shutdown: () => {},
			getContextUsage: () => session.getContextUsage(),
			compact: (options?: CompactOptions) => {
				void (async () => {
					try {
						const result = await session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						options?.onError?.(error instanceof Error ? error : new Error(String(error)));
					}
				})();
			},
			getSystemPrompt: () => session.systemPrompt,
		} as unknown as ExtensionContext;
	}

	/** Run captured handlers for an event; per-handler errors go to the host notify. */
	private async runHandlers(event: string, payload: unknown): Promise<void> {
		const handlers = this.eventHandlers.get(event);
		if (!handlers || handlers.length === 0) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		for (const handler of handlers) {
			try {
				await (handler as ExtensionHandler<unknown>)(payload, ctx);
			} catch (error) {
				this.deps
					.getUi?.()
					?.notify(
						`Subagent ${event} handler failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
			}
		}
	}

	// =========================================================================
	// Tools (formerly pi.registerTool — subagent + subagent_wait). Assembled as
	// customTools in main.ts; execute ctx comes from the session's extension
	// runner, exactly as when they were extension tools.
	// =========================================================================

	// =========================================================================
	// Commands (formerly pi.registerCommand). Dispatched by InteractiveMode.
	// =========================================================================

	hasCommand(name: string): boolean {
		return this.commands.has(name);
	}

	async handleCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		await command.handler(args, ctx as ExtensionCommandContext);
	}

	/** Argument completions captured with the command registration, if any. */
	getArgumentCompletions(
		name: string,
	): ((argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>) | undefined {
		return this.commands.get(name)?.getArgumentCompletions;
	}

	// =========================================================================
	// Shortcut (formerly pi.registerShortcut — Ctrl+Alt+F fleet inspector). Key
	// matching happens in InteractiveMode's onExtensionShortcut composition.
	// =========================================================================

	getShortcutKeys(): string[] {
		return Array.from(this.shortcuts.keys());
	}

	async handleShortcut(key: string): Promise<void> {
		const shortcut = this.shortcuts.get(key);
		if (!shortcut) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		await shortcut.handler(ctx);
	}

	// =========================================================================
	// Message renderers (formerly pi.registerMessageRenderer). Consulted by
	// InteractiveMode when the extension runner has no renderer for a custom
	// message type.
	// =========================================================================

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		return this.messageRenderers.get(customType);
	}

	// =========================================================================
	// Event bus rebinding. pi.events subscriptions were made against the shared
	// bus (pi-intercom / pi-prompt-template-model coordinate over it); re-bind
	// them to the current session's bus on every session_start.
	// =========================================================================

	private rebindEventBus(): void {
		const bus = this.deps.getEvents?.();
		if (bus === this.boundBus) return;
		for (const subscription of this.busSubscriptions) {
			subscription.unsubscribe?.();
			subscription.unsubscribe = undefined;
		}
		this.boundBus = bus;
		if (!bus) return;
		for (const subscription of this.busSubscriptions) {
			subscription.unsubscribe = bus.on(subscription.channel, subscription.handler);
		}
	}

	// =========================================================================
	// Session lifecycle + agent events (formerly pi.on handlers). Driven from
	// agent-session.ts / agent-session-runtime.ts / InteractiveMode at the old
	// extension emit sites.
	// =========================================================================

	async onSessionStart(event: SessionStartEvent): Promise<void> {
		this.rebindEventBus();
		await this.runHandlers("session_start", event);
	}

	async onSessionShutdown(): Promise<void> {
		await this.runHandlers("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
		// Drop this session's bus bindings; subscriptions re-bind on the next start.
		const bus = this.boundBus;
		this.boundBus = undefined;
		if (!bus) return;
		for (const subscription of this.busSubscriptions) {
			subscription.unsubscribe?.();
			subscription.unsubscribe = undefined;
		}
	}

	async onAgentEnd(event: { messages: unknown[] }): Promise<void> {
		await this.runHandlers("agent_end", { type: "agent_end", messages: event.messages });
	}

	async onTurnEnd(event: { turnIndex: number; message: unknown; toolResults: unknown[] }): Promise<void> {
		await this.runHandlers("turn_end", { type: "turn_end", ...event });
	}

	async onToolResult(event: { toolName: string; [key: string]: unknown }): Promise<void> {
		await this.runHandlers("tool_result", { type: "tool_result", ...event });
	}

	async onBeforeAgentStart(event: { prompt: string; systemPrompt: string }): Promise<void> {
		await this.runHandlers("before_agent_start", { type: "before_agent_start", ...event });
	}

	async onSessionCompact(event: { reason?: string; willRetry?: boolean }): Promise<void> {
		await this.runHandlers("session_compact", { type: "session_compact", ...event });
	}

	async onSessionBeforeSwitch(): Promise<void> {
		await this.runHandlers("session_before_switch", { type: "session_before_switch" });
	}

	async onSessionBeforeFork(): Promise<void> {
		await this.runHandlers("session_before_fork", { type: "session_before_fork" });
	}
}

// =========================================================================
// Process-wide singleton (the extension was a per-process factory singleton).
// =========================================================================

let currentSubagentsFeature: SubagentsFeature | undefined;

/**
 * Create (or reconfigure) the process-wide subagents feature. main.ts calls
 * this with no deps so the tools always exist, then configures the session +
 * event-bus getters at session creation; InteractiveMode additionally
 * configures the TUI context.
 */
export function createSubagentsFeature(deps: SubagentsFeatureDeps = {}): SubagentsFeature {
	if (!currentSubagentsFeature) {
		currentSubagentsFeature = new SubagentsFeature(deps);
	} else {
		currentSubagentsFeature.configure(deps);
	}
	return currentSubagentsFeature;
}

/** Current subagents feature, or undefined when none was created (tests, bare sessions). */
export function getSubagentsFeature(): SubagentsFeature | undefined {
	return currentSubagentsFeature;
}

/** Subagent tools for the customTools assembly in main.ts. */
export function createSubagentTools(): ToolDefinition[] {
	return createSubagentsFeature().tools;
}
