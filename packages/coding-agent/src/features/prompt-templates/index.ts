/**
 * Prompt templates — absorbed from the former pi-prompt-template-model baked-in
 * extension into core (~7.7k lines).
 *
 * The moved upstream tree sits next to this file (kept `// @ts-nocheck`,
 * biome-excluded) with only these changes:
 *   - `prompt-loader.ts` imports CONFIG_DIR_NAME/getAgentDir/parseFrontmatter
 *     from core modules directly (was the package barrel), and its
 *     RESERVED_COMMAND_NAMES is derived from BUILTIN_SLASH_COMMANDS so user
 *     templates can never shadow a built-in command.
 *   - `tool-manager.ts` imports getAgentDir from core config directly.
 *   - The old `index.ts` factory is now `extension.ts` (unchanged otherwise).
 *
 * This module is the composition root. It runs the moved default factory once
 * with a host adapter shaped like the old `pi: ExtensionAPI` surface and
 * captures the registrations:
 *   - The `run-prompt` tool is a customTool assembled in main.ts. A late
 *     registration (`/prompt-tool on` mid-session) goes straight into the
 *     current session via AgentSession.addCustomTool (formerly the runner's
 *     registerTool + refreshTools).
 *   - Commands (/chain-prompts, /prompt-tool, and one dynamic command per
 *     user template on disk) are dispatched by AgentSession's
 *     _tryExecuteExtensionCommand fallback — the same site that used to find
 *     them on the extension runner, so they still execute immediately during
 *     streaming/compaction in every mode.
 *   - Message renderers (skill-loaded, delegated subagent, deterministic
 *     step/completion) are consulted by InteractiveMode when the session's
 *     extension runner has no renderer for a custom message type.
 *   - Events (session_start/model_select/before_agent_start/agent_end/
 *     session_before_tree) are direct calls from agent-session.ts at the old
 *     extension emit sites.
 *
 * `pi.events` is a facade over the CURRENT session's shared event bus (the
 * resource loader's bus) — the subagents feature listens there for the
 * `prompt-template:subagent:*` delegation protocol. Subscriptions are tracked
 * and re-bound on every session_start.
 *
 * Contexts come from the CURRENT session's extension runner
 * (createCommandContext) — the exact object the old extension's handlers and
 * commands received, including the InteractiveMode UI bindings and the
 * stale-session guards. Before a session is bound (bare test sessions) every
 * entry point no-ops, matching an unloaded extension.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { EventBus } from "../../core/event-bus.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionHandler,
	MessageRenderer,
	RegisteredCommand,
	SessionStartEvent,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import registerPromptTemplates from "./extension.ts";

// --- Deps ---

/**
 * Session/event-bus access. main.ts configures getSession/getEvents for every
 * mode at session creation; the getters follow session replacement. No
 * InteractiveMode configuration is needed — contexts are built from the
 * session's extension runner, which InteractiveMode binds as before.
 */
export interface PromptTemplatesFeatureDeps {
	getSession?: () => AgentSession | undefined;
	/** Current session's shared extension event bus (pi.events facade target). */
	getEvents?: () => EventBus | undefined;
}

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

interface BusSubscription {
	channel: string;
	handler: (data: unknown) => void;
	unsubscribe?: () => void;
}

/** Result shape of the moved session_before_tree handler (summary override). */
export interface PromptTemplatesBeforeTreeResult {
	cancel?: boolean;
	summary?: { summary: string; details?: unknown };
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

/** Result shape of the moved before_agent_start handler. */
export interface PromptTemplatesBeforeAgentStartResult {
	systemPrompt?: string;
	message?: {
		customType: string;
		content: unknown;
		display: boolean;
		details?: unknown;
	};
}

export class PromptTemplatesFeature {
	private deps: PromptTemplatesFeatureDeps;
	readonly tools: ToolDefinition[] = [];
	private readonly commands = new Map<string, CapturedCommand>();
	private readonly messageRenderers = new Map<string, MessageRenderer>();
	private readonly eventHandlers = new Map<string, ExtensionHandler<never>[]>();
	/** Live facade subscriptions, re-bound to the current session bus on session_start. */
	private busSubscriptions: BusSubscription[] = [];
	private boundBus: EventBus | undefined;
	/** False while the moved factory is registering in the constructor. */
	private captureComplete = false;

	constructor(deps: PromptTemplatesFeatureDeps = {}) {
		this.deps = deps;
		// Run the moved extension factory once, capturing its registrations.
		registerPromptTemplates(this.createHost());
		this.captureComplete = true;
	}

	/** Merge new host capabilities (main.ts (re)configures at session creation). */
	configure(deps: PromptTemplatesFeatureDeps): void {
		this.deps = { ...this.deps, ...deps };
	}

	// =========================================================================
	// Host adapter (the old `pi: ExtensionAPI` surface)
	// =========================================================================

	private createHost(): ExtensionAPI {
		const feature = this;
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
				// Late registration (/prompt-tool on mid-session): the session's
				// customTools were assembled at creation, so push directly into the
				// current session (formerly runner registerTool + refreshTools).
				if (feature.captureComplete) {
					feature.deps.getSession?.()?.addCustomTool(definition);
				}
			},
			registerCommand(name: string, command: CapturedCommand) {
				feature.commands.set(name, command);
			},
			registerMessageRenderer(customType: string, renderer: MessageRenderer) {
				feature.messageRenderers.set(customType, renderer);
			},
			registerEntryRenderer() {},
			registerShortcut() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			registerProvider() {},
			unregisterProvider() {},
			// The moved code only looks up skill commands (source === "skill",
			// sourceInfo.path) to resolve `skill:` frontmatter references.
			getCommands(): SlashCommandInfo[] {
				const session = feature.deps.getSession?.();
				if (!session) return [];
				return session.resourceLoader.getSkills().skills.map((skill) => ({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill" as const,
					sourceInfo: skill.sourceInfo,
				}));
			},
			sendMessage(
				message: Parameters<AgentSession["sendCustomMessage"]>[0],
				options?: Parameters<AgentSession["sendCustomMessage"]>[1],
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session
					.sendCustomMessage(message, options)
					.catch((error) => feature.notifyError(`Prompt template message failed: ${error}`));
			},
			sendUserMessage(
				content: Parameters<AgentSession["sendUserMessage"]>[0],
				options?: { deliverAs?: "steer" | "followUp" },
			) {
				const session = feature.deps.getSession?.();
				if (!session) return;
				session
					.sendUserMessage(content, options)
					.catch((error) => feature.notifyError(`Prompt template send failed: ${error}`));
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
	 * The exact context object the old extension's handlers/commands received:
	 * the current session runner's command context (a superset of the event
	 * context), carrying the InteractiveMode UI bindings, waitForIdle,
	 * navigateTree, and the stale-session guards. Undefined when no session is
	 * bound (callers no-op, same as an unloaded extension).
	 */
	private makeCtx(): ExtensionCommandContext | undefined {
		const session = this.deps.getSession?.();
		if (!session) return undefined;
		return session.extensionRunner.createCommandContext();
	}

	private notifyError(message: string): void {
		const ctx = this.makeCtx();
		if (ctx?.hasUI) {
			ctx.ui.notify(message, "error");
			return;
		}
		process.stderr.write(`${message}\n`);
	}

	/** Run captured handlers for an event; per-handler errors go to notify. */
	private async runHandlers(event: string, payload: unknown): Promise<void> {
		const handlers = this.eventHandlers.get(event);
		if (!handlers || handlers.length === 0) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		for (const handler of handlers) {
			try {
				await (handler as ExtensionHandler<unknown>)(payload, ctx);
			} catch (error) {
				this.notifyError(
					`Prompt template ${event} handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	// =========================================================================
	// Tools (formerly pi.registerTool — run-prompt). Assembled as customTools in
	// main.ts; execute ctx comes from the toolManager's stored command ctx,
	// exactly as when it was an extension tool.
	// =========================================================================

	// =========================================================================
	// Commands (formerly pi.registerCommand — /chain-prompts, /prompt-tool, and
	// one dynamic command per user template). Dispatched by AgentSession's
	// _tryExecuteExtensionCommand fallback.
	// =========================================================================

	hasCommand(name: string): boolean {
		return this.commands.has(name);
	}

	async handleCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) return;
		const ctx = this.makeCtx();
		if (!ctx) return;
		await command.handler(args, ctx);
	}

	/** Name + description of every captured command, for autocomplete. */
	getCommandList(): Array<{ name: string; description?: string }> {
		return Array.from(this.commands.entries()).map(([name, command]) => ({
			name,
			description: command.description,
		}));
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
	// bus (the subagents feature answers the delegation protocol over it);
	// re-bind them to the current session's bus on every session_start.
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
	// Events (formerly pi.on handlers). Driven from agent-session.ts at the old
	// extension emit sites.
	// =========================================================================

	async onSessionStart(event: SessionStartEvent): Promise<void> {
		this.rebindEventBus();
		await this.runHandlers("session_start", event);
	}

	async onModelSelect(event: { model: unknown; previousModel: unknown; source: string }): Promise<void> {
		await this.runHandlers("model_select", { type: "model_select", ...event });
	}

	/**
	 * before_agent_start: the moved handler may append loop/chain guidance to
	 * the system prompt and/or return a pending skill-loaded custom message.
	 * Composed by agent-session.ts after the extension emit + goal hook, before
	 * the memory/behavior blocks (its old position in the builtin load order).
	 */
	async onBeforeAgentStart(event: {
		prompt: string;
		systemPrompt: string;
	}): Promise<PromptTemplatesBeforeAgentStartResult | undefined> {
		const handlers = this.eventHandlers.get("before_agent_start");
		if (!handlers || handlers.length === 0) return undefined;
		const ctx = this.makeCtx();
		if (!ctx) return undefined;
		let systemPrompt: string | undefined;
		let message: PromptTemplatesBeforeAgentStartResult["message"];
		for (const handler of handlers) {
			try {
				const result = (await (handler as ExtensionHandler<unknown>)(
					{
						type: "before_agent_start",
						prompt: event.prompt,
						systemPrompt: systemPrompt ?? event.systemPrompt,
					},
					ctx,
				)) as PromptTemplatesBeforeAgentStartResult | undefined;
				if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
				if (result?.message) message = result.message;
			} catch (error) {
				this.notifyError(
					`Prompt template before_agent_start handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (systemPrompt === undefined && !message) return undefined;
		return { systemPrompt, message };
	}

	async onAgentEnd(event: { messages: unknown[] }): Promise<void> {
		await this.runHandlers("agent_end", { type: "agent_end", messages: event.messages });
	}

	/**
	 * session_before_tree: the moved handler overrides the branch summary for
	 * loop --fresh collapses and boomerang prompts. Composed by agent-session.ts
	 * before the extension emit (its old position in the builtin load order).
	 */
	async onSessionBeforeTree(event: {
		preparation: unknown;
		signal: AbortSignal;
	}): Promise<PromptTemplatesBeforeTreeResult | undefined> {
		const handlers = this.eventHandlers.get("session_before_tree");
		if (!handlers || handlers.length === 0) return undefined;
		const ctx = this.makeCtx();
		if (!ctx) return undefined;
		let result: PromptTemplatesBeforeTreeResult | undefined;
		for (const handler of handlers) {
			try {
				const handlerResult = (await (handler as ExtensionHandler<unknown>)(
					{ type: "session_before_tree", ...event },
					ctx,
				)) as PromptTemplatesBeforeTreeResult | undefined;
				if (handlerResult) {
					result = handlerResult;
					if (result.cancel) return result;
				}
			} catch (error) {
				this.notifyError(
					`Prompt template session_before_tree handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return result;
	}
}

// =========================================================================
// Process-wide singleton (the extension was a per-process factory singleton).
// =========================================================================

let currentPromptTemplatesFeature: PromptTemplatesFeature | undefined;

/**
 * Create (or reconfigure) the process-wide prompt-templates feature. main.ts
 * calls this with no deps so the tools/commands always exist, then configures
 * the session + event-bus getters at session creation.
 */
export function createPromptTemplatesFeature(deps: PromptTemplatesFeatureDeps = {}): PromptTemplatesFeature {
	if (!currentPromptTemplatesFeature) {
		currentPromptTemplatesFeature = new PromptTemplatesFeature(deps);
	} else {
		currentPromptTemplatesFeature.configure(deps);
	}
	return currentPromptTemplatesFeature;
}

/** Current prompt-templates feature, or undefined when none was created (tests, bare sessions). */
export function getPromptTemplatesFeature(): PromptTemplatesFeature | undefined {
	return currentPromptTemplatesFeature;
}

/** Prompt-template tools (run-prompt) for the customTools assembly in main.ts. */
export function createPromptTemplateTools(): ToolDefinition[] {
	return createPromptTemplatesFeature().tools;
}
