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

async function refreshAndCacheModels(session: BridgeSession, key: string): Promise<Model<any>[]> {
	const runtime: ModelRuntime = session.modelRuntime;
	await runtime.refresh();
	const models = [...(await runtime.getAvailable())].sort(
		(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
	);
	modelCache.set(key, { models, expires: Date.now() + MODEL_CACHE_TTL_MS });
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
	bypassBusy: true,
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
			const models = await refreshAndCacheModels(session, ctx.key);
			const current = `${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`;
			const items: PickerItem[] = models.map((m) => ({
				id: `${m.provider}/${m.id}`,
				label: `${m.provider}/${m.id}${`${m.provider}/${m.id}` === current ? " ☾" : ""}`,
			}));
			await createPicker(ctx, {
				command: "model",
				items,
				async onSelect(item) {
					const exact = findExactModelReferenceMatch(item.id, models);
					if (!exact) {
						await ctx.reply("That model is no longer available.");
						return;
					}
					await setModelAndReply(ctx, exact);
				},
			});
			return;
		}

		const numeric = Number.parseInt(arg, 10);
		if (!Number.isNaN(numeric) && /^\d+$/.test(arg)) {
			const cached = modelCache.get(ctx.key);
			if (!cached || Date.now() > cached.expires || numeric < 1 || numeric > cached.models.length) {
				await ctx.reply("Invalid selection — run /model to see the current list.");
				return;
			}
			await setModelAndReply(ctx, cached.models[numeric - 1]);
			return;
		}

		const models = await refreshAndCacheModels(session, ctx.key);
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
		const arg = ctx.args.trim();

		if (!arg) {
			const all = await SessionManager.list(process.cwd());
			all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			const sessions = all.slice(0, 10);
			sessionsCache.set(ctx.key, { sessions, expires: Date.now() + SESSIONS_CACHE_TTL_MS });
			const items: PickerItem[] = sessions.map((s) => ({
				id: s.path,
				label: s.name ? truncate(s.name, 40) : truncate(s.firstMessage, 40) || "(empty)",
			}));
			await createPicker(ctx, {
				command: "session",
				items,
				async onSelect(item) {
					await ctx.bridge.switchSession(ctx.key, item.id);
					const switched = await ctx.bridge.getSession(ctx.key);
					const name = switched?.sessionManager?.getSessionName() ?? "unnamed";
					const count = switched?.sessionManager?.getEntries().length ?? 0;
					await ctx.reply(`Switched to "${name}" (${count} msgs). History continues here.`);
				},
			});
			return;
		}

		let path: string | undefined;
		const numeric = Number.parseInt(arg, 10);
		const cached = sessionsCache.get(ctx.key);
		if (!Number.isNaN(numeric) && /^\d+$/.test(arg)) {
			if (!cached || Date.now() > cached.expires || numeric < 1 || numeric > cached.sessions.length) {
				await ctx.reply("Invalid selection — run /sessions to see the current list.");
				return;
			}
			path = cached.sessions[numeric - 1].path;
		} else {
			const pool =
				cached && Date.now() <= cached.expires ? cached.sessions : await SessionManager.list(process.cwd());
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
			const items: PickerItem[] = levels.map((level) => ({ id: level, label: level }));
			await createPicker(ctx, {
				command: "thinking level",
				items,
				async onSelect(item) {
					const level = item.id as ThinkingLevel;
					session.setThinkingLevel(level);
					await ctx.reply(`Thinking → ${level}`);
				},
			});
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

export function formatHelpText(): string {
	const lines = ["lunR gateway commands:"];
	for (const cmd of CHAT_COMMANDS) {
		const names = [cmd.name, ...(cmd.aliases ?? [])].map((a) => `/${a}`).join(" | ");
		lines.push(`${names} — ${cmd.description}`);
	}
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
