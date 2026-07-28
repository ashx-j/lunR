/**
 * lunR: gateway Telegram adapter (Phase 2b).
 *
 * Talks to the Telegram Bot API over HTTPS long-polling (zero-dep: global
 * fetch). connect() verifies the token via getMe, caches {botId, botUsername},
 * then starts the poll loop (getUpdates, offset-tracked, 30s long-poll). The
 * loop honors 429 retry_after, backs off exponentially on network/5xx errors
 * (1s→2s→5s→…max 30s, reset on success) and stops on disconnect() via an
 * AbortController.
 *
 * Inbound: updateToEvent() is a pure update → MessageEvent mapping (dm/group/
 * channel chat types, forum thread ids with the General topic normalized away,
 * @-mention / text_mention / `/cmd@bot` detection with the mention stripped,
 * own + all-bot messages dropped, media-only dropped — captions accepted).
 * Consecutive texts from the same chat/thread/user are debounced 300ms and
 * merged ("\n"-joined, latest messageId kept) to reassemble client-split long
 * messages; texts starting with "/" flush immediately so commands never merge.
 *
 * Outbound: sendMessage/editMessageText with parse_mode "Markdown" and a
 * one-shot plain-text retry when Telegram rejects the markup; send() honors
 * 429 retry_after once and then reports { success: false, retryable: true }.
 * Message splitting is NOT done here — the router owns that (text.ts).
 *
 * Typing: sendTyping() is a self-contained refresher — Telegram typing
 * bubbles expire after ~5s, so the action is re-sent on an unref'd 4s
 * interval per chat. The interval stops when send() completes for that chat
 * or after 2 minutes without a refresh (safety net). Keeping this here means
 * router/agent-bridge stay untouched.
 *
 * Testability: all Bot API HTTP goes through an injectable callApi; timers go
 * through an injectable Scheduler; backoffDelayMs() is a pure function.
 */

import type { PlatformConfig } from "../config.ts";
import type { ChatType, MessageEvent, PlatformAdapter, SendOptions, SendResult } from "../types.ts";

const API_BASE = "https://api.telegram.org";
const DEFAULT_DEBOUNCE_MS = 300;
const TYPING_INTERVAL_MS = 4000; // bubbles expire after ~5s
const TYPING_SAFETY_MS = 120_000; // auto-stop after 2min without a refresh
const REPLY_TO_TEXT_MAX = 500;
const MARKDOWN_PARSE_ERROR_RE = /can't parse|parse entities/i;
const NOT_MODIFIED_RE = /message is not modified/i;

// ---------------------------------------------------------------------------
// Bot API shapes (only the fields the adapter reads)
// ---------------------------------------------------------------------------

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
	is_forum?: boolean;
}

export interface TelegramEntity {
	type: string;
	offset: number; // UTF-16 code units — same indexing as JS strings
	length: number;
	user?: TelegramUser;
}

export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
	caption?: string;
	entities?: TelegramEntity[];
	caption_entities?: TelegramEntity[];
	message_thread_id?: number;
	reply_to_message?: { text?: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface BotInfo {
	botId: number;
	botUsername: string;
}

interface TelegramApiResponse {
	ok: boolean;
	result?: unknown;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
}

/** Bot API call: resolves with the unwrapped `result`; throws TelegramApiError on API/HTTP errors. */
export type CallApi = (method: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Timer injection seam (production default uses globals, unref'd). */
export interface Scheduler {
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
	setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
	clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export class TelegramApiError extends Error {
	readonly status: number;
	readonly retryAfter?: number;

	constructor(status: number, description: string, retryAfter?: number) {
		super(description);
		this.name = "TelegramApiError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** Exponential poll-error backoff: 1s→2s→5s→10s→30s (max), indexed by consecutive failure count. */
export const BACKOFF_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;

export function backoffDelayMs(consecutiveFailures: number): number {
	const index = Math.min(Math.max(consecutiveFailures, 0), BACKOFF_DELAYS_MS.length - 1);
	return BACKOFF_DELAYS_MS[index];
}

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

async function defaultCallApi(
	token: string,
	method: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const data = (await res.json().catch(() => undefined)) as TelegramApiResponse | undefined;
	if (res.status === 429) {
		throw new TelegramApiError(429, data?.description ?? "rate limited", data?.parameters?.retry_after);
	}
	if (!res.ok || !data?.ok) {
		throw new TelegramApiError(
			data?.error_code ?? res.status,
			data?.description ?? `HTTP ${res.status}`,
			data?.parameters?.retry_after,
		);
	}
	return data.result;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function chatTypeOf(chat: TelegramChat): ChatType | null {
	switch (chat.type) {
		case "private":
			return "dm";
		case "group":
		case "supergroup":
			return "group";
		case "channel":
			return "channel";
		default:
			return null;
	}
}

/**
 * Detect bot mentions via entities and strip them from the text.
 * - "mention" whose slice is `@<botUsername>` (case-insensitive): whole slice removed.
 * - "text_mention" whose user is the bot: whole slice removed.
 * - "bot_command" containing `@<botUsername>` (e.g. /new@lunrbot): only the
 *   "@bot" suffix is removed so router slash-command parsing still works.
 */
function extractMention(
	text: string,
	entities: TelegramEntity[],
	botInfo: BotInfo,
): { text: string; mentioned: boolean } {
	if (!botInfo.botUsername) return { text: text.trim(), mentioned: false };
	const botAt = `@${botInfo.botUsername}`.toLowerCase();
	const removals: Array<[number, number]> = [];
	let mentioned = false;
	for (const entity of entities) {
		const slice = text.slice(entity.offset, entity.offset + entity.length);
		if (entity.type === "mention" && slice.toLowerCase() === botAt) {
			mentioned = true;
			removals.push([entity.offset, entity.offset + entity.length]);
		} else if (entity.type === "text_mention" && entity.user?.id === botInfo.botId) {
			mentioned = true;
			removals.push([entity.offset, entity.offset + entity.length]);
		} else if (entity.type === "bot_command" && slice.toLowerCase().includes(botAt)) {
			mentioned = true;
			const at = slice.toLowerCase().indexOf(botAt);
			removals.push([entity.offset + at, entity.offset + at + botAt.length]);
		}
	}
	if (removals.length === 0) return { text: text.trim(), mentioned };
	removals.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (const [start, end] of removals) {
		out += text.slice(pos, start);
		pos = Math.max(pos, end);
	}
	out += text.slice(pos);
	return { text: out.trim(), mentioned };
}

/**
 * Map a Telegram update to a MessageEvent; null = drop (non-message update,
 * media-only message, own message, any bot message, unknown chat type).
 */
export function updateToEvent(update: TelegramUpdate, botInfo: BotInfo): MessageEvent | null {
	const message = update.message;
	if (!message) return null;
	const from = message.from;
	if (!from) return null; // channel posts without a user signature
	if (from.id === botInfo.botId) return null; // own messages
	if (from.is_bot) return null; // all bots (hermes exclusive_bot_mentions, simplified)

	const rawText = message.text ?? message.caption;
	if (!rawText) return null; // media-only (v1)
	const rawEntities = message.text !== undefined ? message.entities : message.caption_entities;

	const chatType = chatTypeOf(message.chat);
	if (chatType === null) return null;

	// Forum threads only; the General topic (id 1) is normalized away (hermes).
	const threadId =
		message.chat.is_forum === true && message.message_thread_id !== undefined && message.message_thread_id !== 1
			? String(message.message_thread_id)
			: undefined;

	const { text, mentioned } = extractMention(rawText, rawEntities ?? [], botInfo);

	const replyText = message.reply_to_message?.text;

	return {
		text,
		messageId: String(message.message_id),
		replyToText: replyText !== undefined ? replyText.slice(0, REPLY_TO_TEXT_MAX) : undefined,
		source: {
			platform: "telegram",
			chatId: String(message.chat.id),
			chatType,
			userId: String(from.id),
			userName: from.username ?? from.first_name,
			threadId,
		},
		metadata: mentioned ? { mentionedBot: true } : undefined,
	};
}

export interface TelegramAdapterOptions {
	/** Injected Bot API transport (tests). When omitted, HTTPS calls are made with cfg.token. */
	callApi?: CallApi;
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

export class TelegramAdapter implements PlatformAdapter {
	readonly platform = "telegram";
	readonly maxMessageLength = 4096;

	private readonly callApi: CallApi;
	private readonly scheduler: Scheduler;
	private readonly debounceMs: number;
	private readonly now: () => number;
	private handler?: (event: MessageEvent) => void;
	private botInfo?: BotInfo;
	private offset = 0;
	private abortController?: AbortController;
	private readonly pending = new Map<string, PendingEntry>();
	private readonly typing = new Map<string, TypingEntry>();

	constructor(cfg: PlatformConfig, options: TelegramAdapterOptions = {}) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.now = options.now ?? Date.now;
		if (options.callApi) {
			this.callApi = options.callApi;
		} else {
			if (!cfg.token) {
				throw new Error("TelegramAdapter: no bot token (set telegram.token or LUNR_TELEGRAM_BOT_TOKEN)");
			}
			const token = cfg.token;
			this.callApi = (method, body, signal) => defaultCallApi(token, method, body, signal);
		}
	}

	onMessage(handler: (event: MessageEvent) => void): void {
		this.handler = handler;
	}

	async connect(): Promise<boolean> {
		const me = (await this.callApi("getMe", {})) as TelegramUser;
		this.botInfo = { botId: me.id, botUsername: me.username ?? "" };
		this.abortController = new AbortController();
		void this.pollLoop(this.abortController.signal); // intentionally not awaited
		return true;
	}

	async disconnect(): Promise<void> {
		this.abortController?.abort();
		for (const key of [...this.pending.keys()]) this.cancelPending(key);
		for (const key of [...this.typing.keys()]) this.stopTyping(key);
	}

	// -----------------------------------------------------------------------
	// Long-poll loop
	// -----------------------------------------------------------------------

	private async pollLoop(signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			try {
				const updates = (await this.callApi(
					"getUpdates",
					{ offset: this.offset, timeout: 30, allowed_updates: ["message"] },
					signal,
				)) as TelegramUpdate[];
				failures = 0;
				for (const update of updates) {
					this.offset = update.update_id + 1;
					this.dispatchUpdate(update);
				}
			} catch (err) {
				if (signal.aborted) return;
				if (err instanceof TelegramApiError && err.status === 429) {
					await this.sleep((err.retryAfter ?? 1) * 1000, signal);
					continue;
				}
				const delay = backoffDelayMs(failures);
				failures += 1;
				console.error(`[gateway] telegram poll error (retry in ${delay}ms): ${errMessage(err)}`);
				await this.sleep(delay, signal);
			}
		}
	}

	private sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const timer = this.scheduler.setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					this.scheduler.clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	// -----------------------------------------------------------------------
	// Inbound dispatch + debounce
	// -----------------------------------------------------------------------

	private debounceKey(event: MessageEvent): string {
		return `${event.source.chatId}:${event.source.threadId ?? ""}:${event.source.userId}`;
	}

	private dispatchUpdate(update: TelegramUpdate): void {
		if (!this.botInfo || !this.handler) return;
		const event = updateToEvent(update, this.botInfo);
		if (!event) return;
		const key = this.debounceKey(event);
		if (event.text.trimStart().startsWith("/")) {
			// Commands must not merge: flush any pending text, emit immediately.
			this.flushPending(key);
			this.handler(event);
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

	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		// A completed send ends the typing bubble — stop the refresher (see sendTyping).
		this.stopTyping(typingKey(chatId, opts?.threadId));
		const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "Markdown" };
		if (opts?.threadId !== undefined) body.message_thread_id = Number(opts.threadId);
		if (opts?.replyTo !== undefined) body.reply_parameters = { message_id: Number(opts.replyTo) };
		return this.callSend(body);
	}

	private async callSend(body: Record<string, unknown>): Promise<SendResult> {
		try {
			const result = (await this.callApi("sendMessage", body)) as { message_id: number };
			return { success: true, messageId: String(result.message_id) };
		} catch (err) {
			if (err instanceof TelegramApiError && err.status === 400 && body.parse_mode !== undefined) {
				if (MARKDOWN_PARSE_ERROR_RE.test(err.message)) {
					// Telegram rejected our markup: retry once as plain text.
					const { parse_mode: _dropped, ...plain } = body;
					return this.callSend(plain);
				}
			}
			if (err instanceof TelegramApiError && err.status === 429) {
				await this.sleep((err.retryAfter ?? 1) * 1000);
				try {
					const result = (await this.callApi("sendMessage", body)) as { message_id: number };
					return { success: true, messageId: String(result.message_id) };
				} catch (retryErr) {
					return { success: false, error: errMessage(retryErr), retryable: true };
				}
			}
			return {
				success: false,
				error: errMessage(err),
				retryable: !(err instanceof TelegramApiError) || err.status >= 500,
			};
		}
	}

	async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
		const body: Record<string, unknown> = {
			chat_id: chatId,
			message_id: Number(messageId),
			text,
			parse_mode: "Markdown",
		};
		try {
			await this.callApi("editMessageText", body);
			return { success: true, messageId };
		} catch (err) {
			if (err instanceof TelegramApiError && err.status === 400) {
				if (NOT_MODIFIED_RE.test(err.message)) return { success: true, messageId };
				if (MARKDOWN_PARSE_ERROR_RE.test(err.message) && body.parse_mode !== undefined) {
					const { parse_mode: _dropped, ...plain } = body;
					try {
						await this.callApi("editMessageText", plain);
						return { success: true, messageId };
					} catch (retryErr) {
						return { success: false, error: errMessage(retryErr) };
					}
				}
			}
			return {
				success: false,
				error: errMessage(err),
				retryable: !(err instanceof TelegramApiError) || err.status >= 500,
			};
		}
	}

	async sendTyping(chatId: string, threadId?: string): Promise<void> {
		// Self-contained typing refresher (see file header): re-send the action
		// every 4s until send() completes for this chat or the 2min safety net
		// fires — all errors swallowed.
		const key = typingKey(chatId, threadId);
		const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
		if (threadId !== undefined) body.message_thread_id = Number(threadId);
		await this.callApi("sendChatAction", body).catch(() => {});
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
			void this.callApi("sendChatAction", body).catch(() => {});
		}, TYPING_INTERVAL_MS);
		this.typing.set(key, { interval, lastRefresh: this.now() });
	}

	private stopTyping(key: string): void {
		const entry = this.typing.get(key);
		if (!entry) return;
		this.scheduler.clearInterval(entry.interval);
		this.typing.delete(key);
	}
}

function typingKey(chatId: string, threadId?: string): string {
	return `${chatId}:${threadId ?? ""}`;
}
