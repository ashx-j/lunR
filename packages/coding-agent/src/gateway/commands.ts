/**
 * lunR: gateway chat command registry.
 *
 * Every command is a small headless handler over AgentSession. Router.ts keeps
 * platform gating/authorization and delegates to runChatCommand for busy/session
 * guards, error wrapping, and /help generation.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { computeContextBreakdown } from "../core/context-breakdown.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { findExactModelReferenceMatch } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SessionInfo } from "../core/session-manager.ts";
import { SessionManager } from "../core/session-manager.ts";
import { buildSwarmPrompt } from "../core/swarm.ts";
import type { BridgeSession } from "./agent-bridge.ts";
import { createPicker, type PickerItem } from "./buttons.ts";
import type { BridgeLike } from "./router.ts";
import type { MessageEvent, PlatformAdapter } from "./types.ts";

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MODEL_LIST_LINES = 15;
const PROVIDER_PER_PAGE = 10;
const _MODEL_PER_PAGE = 8;
const MAX_MODELS_PER_PROVIDER = 50;
const MODEL_ID_MAX = 38;
const MODEL_CACHE_CAP = 100;
const SESSIONS_CACHE_CAP = 100;

interface ModelCacheEntry {
	models: Model<any>[];
	expires: number;
}

interface SessionsCacheEntry {
	sessions: SessionInfo[];
	expires: number;
}

const modelCache = new Map<string, ModelCacheEntry>();
const sessionsCache = new Map<string, SessionsCacheEntry>();

function evictLRU<K, V>(map: Map<K, V>, cap: number): void {
	while (map.size > cap) {
		const first = map.keys().next().value;
		if (first !== undefined) map.delete(first);
	}
}

function getCachedModels(key: string): Model<any>[] | undefined {
	const cached = modelCache.get(key);
	if (!cached) return undefined;
	if (Date.now() > cached.expires) {
		modelCache.delete(key);
		return undefined;
	}
	// LRU refresh.
	modelCache.delete(key);
	modelCache.set(key, cached);
	return cached.models;
}

function setCachedModels(key: string, models: Model<any>[]): void {
	modelCache.set(key, { models, expires: Date.now() + MODEL_CACHE_TTL_MS });
	evictLRU(modelCache, MODEL_CACHE_CAP);
}

function getCachedSessions(key: string): SessionInfo[] | undefined {
	const cached = sessionsCache.get(key);
	if (!cached) return undefined;
	if (Date.now() > cached.expires) {
		sessionsCache.delete(key);
		return undefined;
	}
	sessionsCache.delete(key);
	sessionsCache.set(key, cached);
	return cached.sessions;
}

function setCachedSessions(key: string, sessions: SessionInfo[]): void {
	sessionsCache.set(key, { sessions, expires: Date.now() + SESSIONS_CACHE_TTL_MS });
	evictLRU(sessionsCache, SESSIONS_CACHE_CAP);
}

export interface ChatCommandContext {
	event: MessageEvent;
	key: string;
	adapter: PlatformAdapter;
	bridge: BridgeLike;
	session?: BridgeSession;
	reply(text: string): Promise<void>;
	args: string;
}

export interface ChatCommand {
	name: string;
	aliases?: string[];
	description: string;
	bypassBusy: boolean;
	needsSession: boolean;
	// biome-ignore lint/suspicious/noConfusingVoidType: handlers may return nothing; runChatCommand treats undefined as consumed.
	handler(ctx: ChatCommandContext): Promise<boolean | void>;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function prefixLines(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line, index) => (index === 0 ? prefix : "  ") + line)
		.join("\n");
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function formatRelativeTime(date: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatModelList(models: Model<any>[], maxLines = MAX_MODEL_LIST_LINES): string[] {
	if (models.length === 0) return ["No models available."];
	const byProvider = new Map<string, Model<any>[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	const providers = [...byProvider.keys()].sort();
	const lines: string[] = [];
	let index = 1;
	for (const provider of providers) {
		const list = (byProvider.get(provider) ?? []).sort((a, b) => a.id.localeCompare(b.id));
		for (const model of list) {
			lines.push(`${index}) ${provider}/${model.id}`);
			index++;
		}
	}
	if (lines.length <= maxLines) return lines;
	return [
		`${models.length} models across ${providers.length} providers.`,
		"Use /model <provider/id> or /model <query>.",
		...providers.map((p) => `- ${p}`),
	];
}

function groupModelsByProvider(models: Model<any>[]): Map<string, Model<any>[]> {
	const byProvider = new Map<string, Model<any>[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	for (const list of byProvider.values()) {
		list.sort((a, b) => a.id.localeCompare(b.id));
	}
	return byProvider;
}

function truncateModelId(id: string): string {
	const lastSlash = id.lastIndexOf("/");
	const name = lastSlash >= 0 ? id.slice(lastSlash + 1) : id;
	return truncate(name, MODEL_ID_MAX);
}

async function refreshAndCacheModels(session: BridgeSession, key: string): Promise<Model<any>[]> {
	const runtime: ModelRuntime = session.modelRuntime;
	await runtime.refresh();
	const models = [...(await runtime.getAvailable())].sort(
		(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
	);
	setCachedModels(key, models);
	return models;
}

async function setModelAndReply(ctx: ChatCommandContext, model: Model<any>): Promise<void> {
	const session = ctx.session!;
	try {
		await session.setModel(model);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("No API key")) {
			await ctx.reply(`No API key for ${model.provider}.`);
			return;
		}
		throw error;
	}
	await ctx.reply(`Model → ${model.provider}/${model.id} (thinking level re-clamped to ${session.thinkingLevel})`);
}

const newCommand: ChatCommand = {
	name: "new",
	aliases: ["reset"],
	description: "start a fresh session for this chat",
	bypassBusy: false,
	needsSession: false,
	async handler(ctx) {
		await ctx.bridge.reset(ctx.key);
		await ctx.reply("Session reset — next message starts a fresh session.");
	},
};

const undoCommand: ChatCommand = {
	name: "undo",
	description: "rewind the session tree before the last user turn",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		const { userText } = await ctx.bridge.undo(ctx.key);
		const text = userText ? ` "${truncate(userText, 60)}"` : "";
		await ctx.reply(`Undone — rewound before${text}. /redo to restore.`);
	},
};

const redoCommand: ChatCommand = {
	name: "redo",
	description: "restore the last undone turn",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		await ctx.bridge.redo(ctx.key);
		await ctx.reply("Redone.");
	},
};

const stopCommand: ChatCommand = {
	name: "stop",
	description: "abort the running turn",
	bypassBusy: true,
	needsSession: false,
	async handler(ctx) {
		await ctx.bridge.abort(ctx.key);
		await ctx.reply("Stopped.");
	},
};

const statusCommand: ChatCommand = {
	name: "status",
	description: "session status",
	bypassBusy: true,
	needsSession: false,
	async handler(ctx) {
		const status = ctx.bridge.getStatus(ctx.key);
		const age = status.createdAt
			? `${Math.max(0, Math.round((Date.now() - Date.parse(status.createdAt)) / 1000))}s`
			: "no session yet";
		await ctx.reply(
			`${ctx.event.source.platform} · session age ${age} · ${status.busy ? "busy" : "idle"} · queue ${status.queueDepth}`,
		);
	},
};

const whoamiCommand: ChatCommand = {
	name: "whoami",
	description: "your ids and session key",
	bypassBusy: true,
	needsSession: false,
	async handler(ctx) {
		const { userId, chatId } = ctx.event.source;
		await ctx.reply(`userId: ${userId}\nchatId: ${chatId}\nkey: ${ctx.key}`);
	},
};

const helpCommand: ChatCommand = {
	name: "help",
	description: "this message",
	bypassBusy: true,
	needsSession: false,
	async handler(ctx) {
		await ctx.reply(formatHelpText());
	},
};

const modelCommand: ChatCommand = {
	name: "model",
	description: "list or switch models",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const arg = ctx.args.trim();
		if (!arg) {
			const cached = getCachedModels(ctx.key);
			const models = cached ?? (await refreshAndCacheModels(session, ctx.key));
			const byProvider = groupModelsByProvider(models);
			const current = session.model;
			const currentRef = current ? `${current.provider}/${current.id}` : "";
			const providers = [...byProvider.keys()].sort();
			const providerItems: PickerItem[] = providers.map((provider) => ({
				label: `${current?.provider === provider ? "✓ " : ""}${provider} (${byProvider.get(provider)?.length ?? 0})`,
				value: provider,
			}));

			const pickerOpts = {
				replyTo: ctx.event.messageId,
				threadId: ctx.event.source.threadId,
			};
			const result = await createPicker(
				ctx.adapter,
				ctx.event.source,
				{
					kind: "model",
					sessionKey: ctx.key,
					invokerId: ctx.event.source.userId,
					items: providerItems,
					perPage: PROVIDER_PER_PAGE,
					title: "Pick a model provider",
					async resolve(item) {
						if (item.value === "__back__") {
							return { done: false, items: providerItems, title: "Pick a model provider" };
						}
						if (!item.value.includes("/")) {
							const provider = item.value;
							const list = byProvider.get(provider) ?? [];
							const capped = list.slice(0, MAX_MODELS_PER_PROVIDER);
							const note =
								list.length > MAX_MODELS_PER_PROVIDER
									? ` — ${list.length - MAX_MODELS_PER_PROVIDER} more available`
									: "";
							const modelItems: PickerItem[] = [];
							for (const m of capped) {
								const ref = `${provider}/${m.id}`;
								modelItems.push({
									label: `${currentRef === ref ? "✓ " : ""}${truncateModelId(m.id)}`,
									value: ref,
								});
							}
							modelItems.unshift({ label: "◀ Back", value: "__back__" });
							return {
								done: false,
								items: modelItems,
								title: `${provider} (${list.length})${note}`,
								breadcrumbs: provider,
							};
						}
						const exact = findExactModelReferenceMatch(item.value, models);
						if (!exact) {
							return { done: true, text: "That model is no longer available." };
						}
						try {
							await session.setModel(exact);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							if (message.includes("No API key")) {
								return { done: true, text: `No API key for ${exact.provider}.` };
							}
							throw error;
						}
						return {
							done: true,
							text: `☾ Model → ${exact.provider}/${exact.id} (thinking level re-clamped to ${session.thinkingLevel})`,
						};
					},
				},
				pickerOpts,
			);
			if (!result.success) {
				const currentText = `${current?.provider ?? "none"}/${current?.id ?? "none"}`;
				const lines = formatModelList(models);
				await ctx.reply([`Current: ${currentText}`, ...lines, "Use /model <n> or /model <provider/id>"].join("\n"));
			}
			return;
		}

		const numeric = Number.parseInt(arg, 10);
		if (!Number.isNaN(numeric) && /^\d+$/.test(arg)) {
			const cached = getCachedModels(ctx.key);
			if (!cached || numeric < 1 || numeric > cached.length) {
				await ctx.reply("Invalid selection — run /model to see the current list.");
				return;
			}
			await setModelAndReply(ctx, cached[numeric - 1]);
			return;
		}

		const models = getCachedModels(ctx.key) ?? (await refreshAndCacheModels(session, ctx.key));
		const exact = findExactModelReferenceMatch(arg, models);
		if (exact) {
			await setModelAndReply(ctx, exact);
			return;
		}

		const query = arg.toLowerCase();
		const matches = models.filter(
			(m) =>
				m.id.toLowerCase().includes(query) ||
				`${m.provider}/${m.id}`.toLowerCase().includes(query) ||
				(m.name?.toLowerCase().includes(query) ?? false),
		);
		if (matches.length === 0) {
			await ctx.reply(`No model matches "${arg}".`);
			return;
		}
		if (matches.length > 1) {
			await ctx.reply(formatModelList(matches).join("\n"));
			return;
		}
		await setModelAndReply(ctx, matches[0]);
	},
};

const sessionsCommand: ChatCommand = {
	name: "sessions",
	description: "list or switch sessions",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const arg = ctx.args.trim();
		const currentFile = session.sessionManager?.getSessionFile();

		if (!arg) {
			const all = await SessionManager.list(process.cwd());
			all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			const sessions = all.slice(0, 10);
			setCachedSessions(ctx.key, sessions);
			const items: PickerItem[] = sessions.map((s) => ({
				label: `${s.path === currentFile ? "☾ " : ""}${s.name ? truncate(s.name, 30) : truncate(s.firstMessage, 30) || "(empty)"}`,
				value: s.path,
			}));
			const result = await createPicker(
				ctx.adapter,
				ctx.event.source,
				{
					kind: "sessions",
					sessionKey: ctx.key,
					invokerId: ctx.event.source.userId,
					items,
					perPage: 8,
					title: "Pick a session",
					async resolve(item) {
						await ctx.bridge.switchSession(ctx.key, item.value);
						const switched = await ctx.bridge.getSession(ctx.key);
						const name = switched?.sessionManager?.getSessionName() ?? "unnamed";
						const count = switched?.sessionManager?.getEntries().length ?? 0;
						return { done: true, text: `☾ Switched to "${name}" (${count} msgs). History continues here.` };
					},
				},
				{ replyTo: ctx.event.messageId, threadId: ctx.event.source.threadId },
			);
			if (!result.success) {
				const lines = sessions.map((s, i) => {
					const marker = s.path === currentFile ? " ☾" : "";
					const label = s.name ? truncate(s.name, 40) : truncate(s.firstMessage, 40) || "(empty)";
					return `${i + 1}) ${label}${marker} · ${formatRelativeTime(s.modified)} · ${s.messageCount} msgs`;
				});
				await ctx.reply(
					[`Sessions for ${process.cwd()}`, ...lines, "Use /sessions <n> or /sessions <id-prefix>"].join("\n"),
				);
			}
			return;
		}

		let path: string | undefined;
		const numeric = Number.parseInt(arg, 10);
		const cached = getCachedSessions(ctx.key);
		if (!Number.isNaN(numeric) && /^\d+$/.test(arg)) {
			if (!cached || numeric < 1 || numeric > cached.length) {
				await ctx.reply("Invalid selection — run /sessions to see the current list.");
				return;
			}
			path = cached[numeric - 1].path;
		} else {
			const pool = cached ?? (await SessionManager.list(process.cwd()));
			const matches = pool.filter((s) => s.id.startsWith(arg) || s.path.startsWith(arg));
			if (matches.length === 0) {
				await ctx.reply(`No session matches "${arg}".`);
				return;
			}
			if (matches.length > 1) {
				await ctx.reply(`Multiple sessions match "${arg}" — use a longer prefix.`);
				return;
			}
			path = matches[0].path;
		}

		if (!path) {
			await ctx.reply("No session selected.");
			return;
		}

		await ctx.bridge.switchSession(ctx.key, path);
		const switched = await ctx.bridge.getSession(ctx.key);
		const name = switched?.sessionManager?.getSessionName() ?? "unnamed";
		const count = switched?.sessionManager?.getEntries().length ?? 0;
		await ctx.reply(`Switched to "${name}" (${count} msgs). History continues here.`);
	},
};

const titleCommand: ChatCommand = {
	name: "title",
	aliases: ["name"],
	description: "name the current session",
	bypassBusy: true,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const name = ctx.args.trim();
		if (!name) {
			const current = session.sessionManager?.getSessionName();
			await ctx.reply(current ? `Session title: ${current}` : "(unnamed)");
			return;
		}
		session.setSessionName(name);
		const readBack = session.sessionManager?.getSessionName() ?? name;
		await ctx.reply(`Session titled "${readBack}".`);
	},
};

const contextCommand: ChatCommand = {
	name: "context",
	description: "estimated context window breakdown",
	bypassBusy: true,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const model = session.model;
		if (!model) {
			await ctx.reply("No model selected.");
			return;
		}
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) {
			await ctx.reply("Context window unknown for this model.");
			return;
		}

		const tools: ToolDefinition[] = session
			.getActiveToolNames()
			.map((name) => session.getToolDefinition(name))
			.filter((d): d is ToolDefinition => d !== undefined);

		const breakdown = computeContextBreakdown({
			systemPrompt: session.systemPrompt,
			tools,
			messages: session.messages,
			contextWindow,
		});

		const usage = session.getContextUsage();
		const tokens = usage?.tokens ?? breakdown.total;
		const percent = usage?.percent ?? (contextWindow > 0 ? (tokens / contextWindow) * 100 : 0);

		const messageTokens =
			breakdown.user +
			breakdown.assistantText +
			breakdown.thinking +
			breakdown.toolCalls +
			breakdown.toolResults +
			breakdown.summaries;

		const stats = session.getSessionStats();
		await ctx.reply(
			[
				`Context: ${tokens.toLocaleString("en-US")} / ${contextWindow.toLocaleString("en-US")} tokens (${Math.round(percent)}%)`,
				`  system ${breakdown.systemPrompt.toLocaleString("en-US")} · tools ${breakdown.toolDefinitions.toLocaleString("en-US")} · messages ${messageTokens.toLocaleString("en-US")}`,
				`Session: ${stats.totalMessages} messages · ${stats.userMessages} turns · model ${model.provider}/${model.id}`,
			].join("\n"),
		);
	},
};

const swarmCommand: ChatCommand = {
	name: "swarm",
	description: "decompose a task across parallel subagents",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		const task = ctx.args.trim();
		if (!task) {
			await ctx.reply("Usage: /swarm <task> — decomposes the task across parallel subagents.");
			return true;
		}
		ctx.event.text = buildSwarmPrompt(task);
		return false;
	},
};

const compactCommand: ChatCommand = {
	name: "compact",
	description: "summarize and compress session context",
	bypassBusy: true,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const instructions = ctx.args.trim() || undefined;
		try {
			const result = await session.compact(instructions);
			const before = result.tokensBefore.toLocaleString("en-US");
			const after =
				result.estimatedTokensAfter !== undefined
					? `~${result.estimatedTokensAfter.toLocaleString("en-US")}`
					: "~?";
			await ctx.reply(`Compacted: ${before} → ${after} tokens.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("Nothing to compact") ||
				message.includes("Already compacted") ||
				message.includes("No model selected")
			) {
				await ctx.reply(message);
				return;
			}
			throw error;
		}
	},
};

const thinkingCommand: ChatCommand = {
	name: "thinking",
	description: "get or set the thinking level",
	bypassBusy: false,
	needsSession: true,
	async handler(ctx) {
		const session = ctx.session!;
		const levels = session.getAvailableThinkingLevels();
		if (!session.supportsThinking()) {
			await ctx.reply(
				`Model ${session.model?.provider ?? "none"}/${session.model?.id ?? "none"} doesn't support thinking.`,
			);
			return;
		}
		const arg = ctx.args.trim().toLowerCase() as ThinkingLevel;
		if (!arg) {
			const current = session.thinkingLevel;
			const items: PickerItem[] = levels.map((level) => ({
				label: `${level === current ? "✓ " : ""}${level}`,
				value: level,
			}));
			const result = await createPicker(
				ctx.adapter,
				ctx.event.source,
				{
					kind: "thinking",
					sessionKey: ctx.key,
					invokerId: ctx.event.source.userId,
					items,
					perPage: levels.length,
					title: "Pick a thinking level",
					async resolve(item) {
						const level = item.value as ThinkingLevel;
						session.setThinkingLevel(level);
						return { done: true, text: `☾ Thinking → ${level}` };
					},
				},
				{ replyTo: ctx.event.messageId, threadId: ctx.event.source.threadId },
			);
			if (!result.success) {
				await ctx.reply(`Level: ${current} — available: ${levels.join(", ")}`);
			}
			return;
		}
		if (!levels.includes(arg)) {
			await ctx.reply(`Invalid level. Available: ${levels.join(", ")}`);
			return;
		}
		session.setThinkingLevel(arg);
		await ctx.reply(`Thinking → ${arg}`);
	},
};

export const CHAT_COMMANDS: ChatCommand[] = [
	newCommand,
	undoCommand,
	redoCommand,
	stopCommand,
	statusCommand,
	whoamiCommand,
	helpCommand,
	modelCommand,
	sessionsCommand,
	titleCommand,
	contextCommand,
	swarmCommand,
	compactCommand,
	thinkingCommand,
];

/** Platform menu specs (e.g. Telegram setMyCommands): canonical names only, aliases skipped. */
export function botCommandSpecs(): { name: string; description: string }[] {
	return CHAT_COMMANDS.map((c) => ({ name: c.name, description: c.description }));
}

export function formatHelpText(): string {
	const lines = ["lunR gateway commands:"];
	for (const cmd of CHAT_COMMANDS) {
		const names = [cmd.name, ...(cmd.aliases ?? [])].map((a) => `/${a}`).join(" | ");
		lines.push(`${names} — ${cmd.description}`);
	}
	lines.push("");
	lines.push("Tap to pick: /model, /thinking, /sessions (run without args to see buttons).");
	return lines.join("\n");
}

/**
 * Run a chat command with busy/session guards and error → "⚠ one-line".
 * Returns true when the event was consumed by the command, false when the
 * router should continue (e.g. /swarm mutates the event and wants a normal turn).
 */
export async function runChatCommand(cmd: ChatCommand, ctx: ChatCommandContext): Promise<boolean> {
	if (!cmd.bypassBusy && ctx.bridge.getStatus(ctx.key).busy) {
		await ctx.reply("⏳ busy — /stop first or wait");
		return true;
	}
	if (cmd.needsSession) {
		const session = await ctx.bridge.getSession(ctx.key);
		if (!session) {
			await ctx.reply("No session yet — send a message first.");
			return true;
		}
		ctx.session = session;
	}
	try {
		const consumed = await cmd.handler(ctx);
		return consumed ?? true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await ctx.adapter.send(ctx.event.source.chatId, `⚠ ${oneLine(message)}`, {
			replyTo: ctx.event.messageId,
			threadId: ctx.event.source.threadId,
		});
		return true;
	}
}

/** Reply helper used by the router to build the ChatCommandContext. */
export async function sendCommandReply(adapter: PlatformAdapter, event: MessageEvent, text: string): Promise<void> {
	await adapter.send(event.source.chatId, prefixLines(text, "☾ "), {
		replyTo: event.messageId,
		threadId: event.source.threadId,
	});
}
