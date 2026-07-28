/**
 * lunR: gateway Discord adapter (Phase 3).
 *
 * Built on discord.js v14 (gateway websocket; the library owns reconnects and
 * REST rate-limit queuing internally, so neither is handled here). No voice,
 * no native slash-command registration — commands arrive as plain message
 * text, same as Telegram.
 *
 * Intents: Guilds, GuildMessages, DirectMessages, MessageContent. GuildMembers
 * is deliberately NOT requested: it is a privileged intent, and asking for it
 * without the dev-portal opt-in makes Discord refuse the identify — the bot
 * connects and immediately goes offline. v1 has no role-based config
 * (SessionSource.roleAuthorized stays undefined), so there is nothing to gain.
 *
 * Inbound: messageToEvent() is the pure message → MessageEvent mapping
 * (dm/group/thread chat types, <@id>/<@!id> mention detection with the mention
 * stripped, thread-participation counts as a mention, own + all-bot + system +
 * attachment-only messages dropped, other-mention-without-us dropped outside
 * DMs — hermes DISCORD_IGNORE_NO_MENTION). A module-level seen-id Set
 * (cap 500, FIFO evict) drops gateway-resume replays. cfg.ignoredChannels is
 * enforced adapter-side (channel id or parent id; blacklist wins over
 * mentions). Consecutive texts from the same chat/thread/user are debounced
 * 600ms and merged ("\n"-joined, latest messageId kept); texts starting with
 * "/" flush immediately so commands never merge.
 *
 * chatId/threadId mapping (pairs with session-keys.ts buildSessionKey):
 *   dm     → chatId = channel.id                        → agent:main:discord:dm:<channelId>
 *   thread → chatId = PARENT channel id, threadId =     → agent:main:discord:thread:<parentId>:<threadId>
 *            thread channel id (shared session, no userId)
 *   guild text/announcement → chatId = channel.id       → agent:main:discord:group:<channelId>[:<userId>]
 *            (chatType "group"; userId appended when groupSessionsPerUser is on)
 *
 * autoThread (cfg.discord.autoThread, default true): a bot-mentioning message
 * in a guild TEXT channel gets a thread spun off it (startThread, 60min
 * archive); the event is re-targeted to the thread (chatType "thread", chatId
 * parent id, threadId thread id). On failure the event stays in-channel.
 *
 * Thread participation: an in-memory Set of thread ids the bot has sent to
 * (recorded on every successful send() into a thread and on autoThread
 * creation); messages in those threads count as mentionedBot so follow-ups
 * don't need a re-mention. NOT persisted in v1 (hermes persists it).
 *
 * Outbound: channel.send({ content, reply: { messageReference } }) with a
 * one-shot plain-send fallback when the reply reference fails. DiscordAPIError
 * 50035 (invalid form body, e.g. overlong content) is reported non-retryable;
 * 429s are queued internally by discord.js; everything else is retryable.
 * editMessage resolves the channel via a messageId → channel map recorded at
 * send() time (router passes only chatId, but thread messages live in their
 * own channel); Unknown Message (10008) is a terminal { success: false }.
 * Message splitting is NOT done here — the router owns that (text.ts).
 *
 * Typing: sendTyping() is a self-contained refresher — Discord typing bubbles
 * last ~10s, so the action is re-sent on an unref'd 8s interval per target.
 * The interval stops when send() completes for that target or after 2 minutes
 * without a refresh (safety net). All errors swallowed.
 *
 * Testability: the discord.js Client goes through an injectable clientFactory
 * (tests inject a minimal fake), timers through an injectable Scheduler, and
 * messageToEvent() operates on the structural DiscordMessageLike — plain mock
 * objects, no real Client construction.
 */

import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import type { DiscordConfig } from "../config.ts";
import type { ChatType, MessageEvent, PlatformAdapter, SendOptions, SendResult } from "../types.ts";
import type { Scheduler } from "./telegram.ts";

const DEFAULT_DEBOUNCE_MS = 600;
const TYPING_INTERVAL_MS = 8000; // Discord typing lasts ~10s
const TYPING_SAFETY_MS = 120_000; // auto-stop after 2min without a refresh
const REPLY_TO_TEXT_MAX = 500;
const THREAD_NAME_MAX = 40;
const SEEN_CAP = 500;
const SENT_CHANNEL_CAP = 500;
const ERR_INVALID_FORM_BODY = 50035; // e.g. content over 2000 chars — non-retryable
const ERR_UNKNOWN_MESSAGE = 10008; // deleted/unknown message — terminal

const THREAD_TYPES: readonly number[] = [
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
];

// ---------------------------------------------------------------------------
// Structural discord.js shapes (only the fields the adapter reads)
// ---------------------------------------------------------------------------

export interface DiscordSentMessageLike {
	id: string;
}

export interface DiscordFetchedMessageLike {
	content?: string;
	edit?(text: string): Promise<unknown>;
}

export interface DiscordChannelLike {
	id: string;
	type: number;
	parentId?: string | null;
	send?(payload: { content: string; reply?: { messageReference: string } }): Promise<DiscordSentMessageLike>;
	sendTyping?(): Promise<unknown>;
	messages?: {
		cache?: { get(id: string): { content?: string } | undefined };
		fetch(id: string): Promise<DiscordFetchedMessageLike | null>;
	};
}

export interface DiscordMessageLike {
	id: string;
	content?: string;
	system?: boolean;
	author: { id: string; bot?: boolean; username?: string };
	channel: DiscordChannelLike;
	reference?: { messageId?: string | null } | null;
	mentions?: {
		has(user: { id: string }): boolean;
		repliedUser?: { id: string } | null;
	};
	startThread?(opts: { name: string; autoArchiveDuration: number }): Promise<DiscordChannelLike>;
}

/** Minimal Client surface; the real discord.js Client satisfies this. */
export interface DiscordClientLike {
	user: { id: string } | null;
	login(token: string): Promise<unknown>;
	on(event: string, listener: (message: DiscordMessageLike) => void): unknown;
	once(event: string, listener: () => void): unknown;
	destroy(): void;
	channels: { fetch(id: string): Promise<DiscordChannelLike | null> };
}

export type DiscordClientFactory = () => DiscordClientLike;

// ---------------------------------------------------------------------------
// Pure mapping + small helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Discord REST error code (DiscordAPIError.code) when present. */
function discordErrorCode(err: unknown): number | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "number" ? code : undefined;
}

export interface MessageToEventOptions {
	/** Channel ids (or parent ids for threads) to drop outright — blacklist wins over mentions. */
	ignoredChannels?: readonly string[];
	/** Threads the bot has spoken in; messages there count as mentionedBot. */
	participatingThreads?: ReadonlySet<string>;
}

/**
 * Map a Discord message to a MessageEvent; null = drop (own message, any bot,
 * system message, attachment-only, ignored channel, unsupported channel type,
 * or a non-DM message mentioning others but not us).
 */
export function messageToEvent(
	message: DiscordMessageLike,
	botUser: { id: string },
	options: MessageToEventOptions = {},
): MessageEvent | null {
	const author = message.author;
	if (!author) return null;
	if (author.id === botUser.id) return null; // own messages
	if (author.bot) return null; // all bots (same simplification as telegram)
	if (message.system) return null;
	const content = (message.content ?? "").trim();
	if (content === "") return null; // attachment-only (v1)

	const channel = message.channel;
	const ignored = options.ignoredChannels ?? [];
	if (ignored.includes(channel.id) || (channel.parentId != null && ignored.includes(channel.parentId))) {
		return null; // blacklist wins over mentions
	}

	// chatId/threadId mapping — see the file header for the session-key pairing.
	let chatType: ChatType;
	let chatId: string;
	let threadId: string | undefined;
	if (channel.type === ChannelType.DM) {
		chatType = "dm";
		chatId = channel.id;
	} else if (THREAD_TYPES.includes(channel.type)) {
		chatType = "thread";
		chatId = channel.parentId ?? channel.id;
		threadId = channel.id;
	} else if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
		chatType = "group";
		chatId = channel.id;
	} else {
		return null; // voice/category/forum containers etc. — unsupported in v1
	}

	const explicitMention = message.mentions?.has(botUser) === true;
	const participating = threadId !== undefined && options.participatingThreads?.has(threadId) === true;
	const mentionedBot = explicitMention || participating;

	// Multi-agent filter (hermes DISCORD_IGNORE_NO_MENTION): outside DMs, a
	// message that mentions other users/bots but not us is not for us.
	if (!mentionedBot && chatType !== "dm") {
		const mentionedIds = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
		if (mentionedIds.some((id) => id !== botUser.id)) return null;
	}

	let text = content;
	if (explicitMention) {
		text = text.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim();
	}

	const refId = message.reference?.messageId;
	const cachedReply = refId != null ? channel.messages?.cache?.get(refId)?.content : undefined;

	return {
		text,
		messageId: message.id,
		replyToText: cachedReply !== undefined ? cachedReply.slice(0, REPLY_TO_TEXT_MAX) : undefined,
		source: {
			platform: "discord",
			chatId,
			chatType,
			userId: author.id,
			userName: author.username,
			threadId,
		},
		metadata: mentionedBot ? { mentionedBot: true } : undefined,
	};
}

// ---------------------------------------------------------------------------
// Gateway-resume replay dedup (module-level: one process = one bot connection)
// ---------------------------------------------------------------------------

const seenMessageIds = new Set<string>();

/** Returns true when this id was already seen (drop the replay). */
function markMessageSeen(id: string): boolean {
	if (seenMessageIds.has(id)) return true;
	seenMessageIds.add(id);
	if (seenMessageIds.size > SEEN_CAP) {
		const oldest = seenMessageIds.values().next().value; // Sets iterate in insertion order
		if (oldest !== undefined) seenMessageIds.delete(oldest);
	}
	return false;
}

/** Test hook: reset RESUME dedup state between tests. */
export function resetSeenMessageIds(): void {
	seenMessageIds.clear();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const defaultScheduler: Scheduler = {
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle),
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearInterval: (handle) => clearInterval(handle),
};

function defaultClientFactory(): DiscordClientLike {
	// No GatewayIntentBits.GuildMembers — see the file header for the
	// privileged-intent trap (bot stays offline without the portal opt-in).
	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
	}) as unknown as DiscordClientLike;
}

export interface DiscordAdapterOptions {
	/** Injected Client factory (tests). When omitted, a real discord.js Client is created. */
	clientFactory?: DiscordClientFactory;
	scheduler?: Scheduler;
	debounceMs?: number;
	now?: () => number;
}

interface PendingEntry {
	event: MessageEvent;
	timer: ReturnType<typeof setTimeout>;
}

interface TypingEntry {
	interval: ReturnType<typeof setInterval>;
	lastRefresh: number;
}

function typingKey(chatId: string, threadId?: string): string {
	return `${chatId}:${threadId ?? ""}`;
}

export class DiscordAdapter implements PlatformAdapter {
	readonly platform = "discord";
	readonly maxMessageLength = 2000;

	private readonly cfg: DiscordConfig;
	private readonly clientFactory: DiscordClientFactory;
	private readonly scheduler: Scheduler;
	private readonly debounceMs: number;
	private readonly now: () => number;
	private client?: DiscordClientLike;
	private botUserId?: string;
	private handler?: (event: MessageEvent) => void;
	private readonly pending = new Map<string, PendingEntry>();
	private readonly typing = new Map<string, TypingEntry>();
	private readonly channelCache = new Map<string, DiscordChannelLike | null>();
	/** Threads the bot has spoken in (session memory only; hermes persists this). */
	private readonly participatingThreads = new Set<string>();
	/** messageId → channel it was sent to, so editMessage finds thread messages. */
	private readonly sentMessageChannels = new Map<string, string>();

	constructor(cfg: DiscordConfig, options: DiscordAdapterOptions = {}) {
		this.cfg = cfg;
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.now = options.now ?? Date.now;
		if (options.clientFactory) {
			this.clientFactory = options.clientFactory;
		} else {
			if (!cfg.token) {
				throw new Error("DiscordAdapter: no bot token (set discord.token or LUNR_DISCORD_BOT_TOKEN)");
			}
			this.clientFactory = defaultClientFactory;
		}
	}

	onMessage(handler: (event: MessageEvent) => void): void {
		this.handler = handler;
	}

	async connect(): Promise<boolean> {
		if (!this.cfg.token) {
			throw new Error("DiscordAdapter: no bot token (set discord.token or LUNR_DISCORD_BOT_TOKEN)");
		}
		const client = this.clientFactory();
		this.client = client;
		client.on(Events.MessageCreate, (message) => {
			void this.handleMessage(message).catch((err) => {
				console.error(`[gateway] discord message handling error: ${errMessage(err)}`);
			});
		});
		const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
		try {
			await client.login(this.cfg.token);
		} catch (err) {
			console.error(`[gateway] discord login failed: ${errMessage(err)}`);
			return false;
		}
		await ready;
		this.botUserId = client.user?.id;
		if (this.botUserId === undefined) {
			console.error("[gateway] discord: client ready without a user — cannot map messages");
			return false;
		}
		return true;
	}

	async disconnect(): Promise<void> {
		for (const key of [...this.pending.keys()]) this.cancelPending(key);
		for (const key of [...this.typing.keys()]) this.stopTyping(key);
		this.channelCache.clear();
		this.client?.destroy();
		this.client = undefined;
	}

	// -----------------------------------------------------------------------
	// Inbound dispatch + debounce
	// -----------------------------------------------------------------------

	private async handleMessage(message: DiscordMessageLike): Promise<void> {
		if (!this.botUserId || !this.handler) return;
		if (markMessageSeen(message.id)) return; // gateway-resume replay
		const event = messageToEvent(
			message,
			{ id: this.botUserId },
			{
				ignoredChannels: this.cfg.ignoredChannels,
				participatingThreads: this.participatingThreads,
			},
		);
		if (!event) return;
		await this.resolveReplyToText(message, event);
		await this.maybeAutoThread(message, event);
		this.dispatchEvent(event);
	}

	/** Best-effort: fill replyToText from the referenced message when it wasn't cached. */
	private async resolveReplyToText(message: DiscordMessageLike, event: MessageEvent): Promise<void> {
		if (event.replyToText !== undefined) return;
		const refId = message.reference?.messageId;
		if (refId == null) return;
		const messages = message.channel.messages;
		if (!messages) return;
		try {
			const referenced = await messages.fetch(refId);
			if (referenced?.content) event.replyToText = referenced.content.slice(0, REPLY_TO_TEXT_MAX);
		} catch {
			// unknown/deleted reference — no reply context
		}
	}

	/** autoThread: spin a thread off a bot-mentioning guild-text message and re-target the event. */
	private async maybeAutoThread(message: DiscordMessageLike, event: MessageEvent): Promise<void> {
		if (!this.cfg.autoThread) return;
		if (event.metadata?.mentionedBot !== true) return;
		// Only guild TEXT channels: DMs can't thread and messages already inside
		// a thread don't need another one.
		if (message.channel.type !== ChannelType.GuildText) return;
		if (typeof message.startThread !== "function") return;
		try {
			const thread = await message.startThread({
				name: (event.text || "conversation").slice(0, THREAD_NAME_MAX),
				autoArchiveDuration: 60,
			});
			this.participatingThreads.add(thread.id);
			event.source = { ...event.source, chatType: "thread", chatId: message.channel.id, threadId: thread.id };
		} catch {
			// e.g. missing CREATE_THREADS permission — respond in-channel instead.
		}
	}

	private debounceKey(event: MessageEvent): string {
		return `${event.source.chatId}:${event.source.threadId ?? ""}:${event.source.userId}`;
	}

	private dispatchEvent(event: MessageEvent): void {
		const key = this.debounceKey(event);
		if (event.text.trimStart().startsWith("/")) {
			// Commands must not merge: flush any pending text, emit immediately.
			this.flushPending(key);
			this.handler?.(event);
			return;
		}
		const existing = this.pending.get(key);
		if (existing) {
			this.scheduler.clearTimeout(existing.timer);
			// Merge: earlier text first, latest messageId (and other fields) win.
			existing.event = { ...event, text: `${existing.event.text}\n${event.text}` };
			existing.timer = this.scheduler.setTimeout(() => this.flushPending(key), this.debounceMs);
		} else {
			const timer = this.scheduler.setTimeout(() => this.flushPending(key), this.debounceMs);
			this.pending.set(key, { event, timer });
		}
	}

	private flushPending(key: string): void {
		const entry = this.pending.get(key);
		if (!entry) return;
		this.scheduler.clearTimeout(entry.timer);
		this.pending.delete(key);
		this.handler?.(entry.event);
	}

	private cancelPending(key: string): void {
		const entry = this.pending.get(key);
		if (!entry) return;
		this.scheduler.clearTimeout(entry.timer);
		this.pending.delete(key);
	}

	// -----------------------------------------------------------------------
	// Outbound
	// -----------------------------------------------------------------------

	private async fetchChannel(id: string): Promise<DiscordChannelLike | null> {
		if (this.channelCache.has(id)) return this.channelCache.get(id) ?? null;
		if (!this.client) return null;
		try {
			const channel = await this.client.channels.fetch(id);
			this.channelCache.set(id, channel);
			return channel;
		} catch {
			this.channelCache.set(id, null);
			return null;
		}
	}

	private recordSent(messageId: string, channel: DiscordChannelLike): void {
		if (THREAD_TYPES.includes(channel.type)) this.participatingThreads.add(channel.id);
		this.sentMessageChannels.set(messageId, channel.id);
		if (this.sentMessageChannels.size > SENT_CHANNEL_CAP) {
			const oldest = this.sentMessageChannels.keys().next().value;
			if (oldest !== undefined) this.sentMessageChannels.delete(oldest);
		}
	}

	private async trySend(
		channel: DiscordChannelLike,
		payload: { content: string; reply?: { messageReference: string } },
	): Promise<SendResult> {
		if (typeof channel.send !== "function") {
			return { success: false, error: `channel ${channel.id} is not sendable` };
		}
		try {
			const sent = await channel.send(payload);
			this.recordSent(sent.id, channel);
			return { success: true, messageId: sent.id };
		} catch (err) {
			// 429s are queued internally by discord.js and don't surface here.
			return { success: false, error: errMessage(err), retryable: discordErrorCode(err) !== ERR_INVALID_FORM_BODY };
		}
	}

	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		// A completed send ends the typing bubble — stop the refresher (see sendTyping).
		this.stopTyping(typingKey(chatId, opts?.threadId));
		const channel = await this.fetchChannel(opts?.threadId ?? chatId);
		if (!channel) return { success: false, error: `channel ${opts?.threadId ?? chatId} not found` };
		const result = await this.trySend(channel, {
			content: text,
			reply: opts?.replyTo !== undefined ? { messageReference: opts.replyTo } : undefined,
		});
		if (!result.success && opts?.replyTo !== undefined) {
			// The reply target may be deleted/unknown — fall back to a plain send.
			return this.trySend(channel, { content: text });
		}
		return result;
	}

	async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
		// The router passes only chatId; thread messages live in their own
		// channel, so prefer the channel recorded at send() time.
		const channel = await this.fetchChannel(this.sentMessageChannels.get(messageId) ?? chatId);
		if (!channel?.messages) {
			return { success: false, error: `channel ${this.sentMessageChannels.get(messageId) ?? chatId} not found` };
		}
		try {
			const message = await channel.messages.fetch(messageId);
			if (!message || typeof message.edit !== "function") {
				return { success: false, error: `message ${messageId} not found` };
			}
			await message.edit(text);
			return { success: true, messageId };
		} catch (err) {
			const code = discordErrorCode(err);
			if (code === ERR_UNKNOWN_MESSAGE) return { success: false, error: errMessage(err) }; // terminal
			return { success: false, error: errMessage(err), retryable: true };
		}
	}

	async sendTyping(chatId: string, threadId?: string): Promise<void> {
		// Self-contained typing refresher (see file header): re-send the action
		// every 8s until send() completes for this target or the 2min safety net
		// fires — all errors swallowed.
		const key = typingKey(chatId, threadId);
		const targetId = threadId ?? chatId;
		await this.doTyping(targetId);
		const existing = this.typing.get(key);
		if (existing) {
			existing.lastRefresh = this.now();
			return;
		}
		const interval = this.scheduler.setInterval(() => {
			const entry = this.typing.get(key);
			if (!entry) return;
			if (this.now() - entry.lastRefresh > TYPING_SAFETY_MS) {
				this.stopTyping(key);
				return;
			}
			void this.doTyping(targetId);
		}, TYPING_INTERVAL_MS);
		this.typing.set(key, { interval, lastRefresh: this.now() });
	}

	private async doTyping(channelId: string): Promise<void> {
		try {
			const channel = await this.fetchChannel(channelId);
			await channel?.sendTyping?.();
		} catch {
			// typing is cosmetic — never surface
		}
	}

	private stopTyping(key: string): void {
		const entry = this.typing.get(key);
		if (!entry) return;
		this.scheduler.clearInterval(entry.interval);
		this.typing.delete(key);
	}
}
