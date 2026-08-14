import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BotInfo,
	backoffDelayMs,
	TelegramAdapter,
	TelegramApiError,
	type TelegramEntity,
	type TelegramMessage,
	type TelegramUpdate,
	updateToEvent,
} from "../src/gateway/adapters/telegram.ts";
import type { PlatformConfig } from "../src/gateway/config.ts";
import type { MessageEvent } from "../src/gateway/types.ts";

const BOT: BotInfo = { botId: 777, botUsername: "lunrbot" };

const CFG: PlatformConfig = {
	enabled: true,
	token: "test-token",
	allowedUsers: [],
	allowedChats: [],
	requireMention: false,
	freeResponseChats: [],
};

let nextId = 1000;

interface UpdateOptions {
	text?: string;
	caption?: string;
	chatType?: string;
	chatId?: number;
	isForum?: boolean;
	threadId?: number;
	fromId?: number;
	isBot?: boolean;
	username?: string;
	entities?: TelegramEntity[];
	captionEntities?: TelegramEntity[];
	replyText?: string;
	messageId?: number;
	updateId?: number;
}

function makeUpdate(options: UpdateOptions = {}): TelegramUpdate {
	const message: TelegramMessage = {
		message_id: options.messageId ?? ++nextId,
		from: { id: options.fromId ?? 42, is_bot: options.isBot, username: options.username ?? "alice" },
		chat: { id: options.chatId ?? 555, type: options.chatType ?? "private", is_forum: options.isForum },
	};
	if (options.text !== undefined) message.text = options.text;
	if (options.caption !== undefined) message.caption = options.caption;
	if (options.entities) message.entities = options.entities;
	if (options.captionEntities) message.caption_entities = options.captionEntities;
	if (options.threadId !== undefined) message.message_thread_id = options.threadId;
	if (options.replyText !== undefined) message.reply_to_message = { text: options.replyText };
	return { update_id: options.updateId ?? ++nextId, message };
}

/** Records every call; serves per-method queued results/errors, then falls back. */
class MockApi {
	calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	private queues = new Map<string, unknown[]>();
	fallback: (method: string, body: Record<string, unknown>) => unknown = () => ({});

	callApi = (method: string, body: Record<string, unknown>): Promise<unknown> => {
		this.calls.push({ method, body });
		const queue = this.queues.get(method);
		if (queue && queue.length > 0) {
			const next = queue.shift();
			if (next instanceof Error) return Promise.reject(next);
			return Promise.resolve(next);
		}
		return Promise.resolve(this.fallback(method, body));
	};

	queue(method: string, ...results: unknown[]): void {
		this.queues.set(method, results);
	}

	callsFor(method: string): Array<Record<string, unknown>> {
		return this.calls.filter((c) => c.method === method).map((c) => c.body);
	}
}

/** Parked promise: keeps the poll loop suspended once queued batches run out. */
function park(): Promise<never> {
	return new Promise<never>(() => {});
}

describe("updateToEvent", () => {
	it("maps a DM text message", () => {
		const event = updateToEvent(makeUpdate({ text: "hi" }), BOT);
		expect(event).not.toBeNull();
		expect(event?.text).toBe("hi");
		expect(event?.source).toEqual({
			platform: "telegram",
			chatId: "555",
			chatType: "dm",
			userId: "42",
			userName: "alice",
			threadId: undefined,
		});
		expect(event?.metadata).toBeUndefined();
	});

	it("maps group, supergroup and channel chat types", () => {
		expect(updateToEvent(makeUpdate({ text: "x", chatType: "group" }), BOT)?.source.chatType).toBe("group");
		expect(updateToEvent(makeUpdate({ text: "x", chatType: "supergroup" }), BOT)?.source.chatType).toBe("group");
		expect(updateToEvent(makeUpdate({ text: "x", chatType: "channel" }), BOT)?.source.chatType).toBe("channel");
	});

	it("sets threadId only for forum topics and normalizes the General topic (id 1)", () => {
		const forum = { chatType: "supergroup", isForum: true };
		expect(updateToEvent(makeUpdate({ text: "x", ...forum, threadId: 42 }), BOT)?.source.threadId).toBe("42");
		expect(updateToEvent(makeUpdate({ text: "x", ...forum, threadId: 1 }), BOT)?.source.threadId).toBeUndefined();
		expect(
			updateToEvent(makeUpdate({ text: "x", chatType: "supergroup", threadId: 42 }), BOT)?.source.threadId,
		).toBeUndefined();
	});

	it("detects and strips an @-mention entity", () => {
		const event = updateToEvent(
			makeUpdate({ text: "@lunrbot hello", entities: [{ type: "mention", offset: 0, length: 8 }] }),
			BOT,
		);
		expect(event?.text).toBe("hello");
		expect(event?.metadata).toEqual({ mentionedBot: true });
	});

	it("matches mentions case-insensitively and strips trailing mentions", () => {
		const event = updateToEvent(
			makeUpdate({ text: "hello @LunrBot", entities: [{ type: "mention", offset: 6, length: 8 }] }),
			BOT,
		);
		expect(event?.text).toBe("hello");
		expect(event?.metadata).toEqual({ mentionedBot: true });
	});

	it("ignores mentions of other users", () => {
		const event = updateToEvent(
			makeUpdate({ text: "@someone hello", entities: [{ type: "mention", offset: 0, length: 8 }] }),
			BOT,
		);
		expect(event?.text).toBe("@someone hello");
		expect(event?.metadata).toBeUndefined();
	});

	it("detects and strips a text_mention of the bot", () => {
		const event = updateToEvent(
			makeUpdate({
				text: "lunr bot hello",
				entities: [{ type: "text_mention", offset: 0, length: 8, user: { id: BOT.botId } }],
			}),
			BOT,
		);
		expect(event?.text).toBe("hello");
		expect(event?.metadata).toEqual({ mentionedBot: true });
	});

	it("ignores a text_mention of another user", () => {
		const event = updateToEvent(
			makeUpdate({
				text: "bob hello",
				entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 999 } }],
			}),
			BOT,
		);
		expect(event?.metadata).toBeUndefined();
	});

	it("treats /cmd@bot as a mention and strips only the @bot suffix", () => {
		const event = updateToEvent(
			makeUpdate({ text: "/new@lunrbot", entities: [{ type: "bot_command", offset: 0, length: 12 }] }),
			BOT,
		);
		expect(event?.text).toBe("/new");
		expect(event?.metadata).toEqual({ mentionedBot: true });
	});

	it("does not treat a bare /cmd as a mention", () => {
		const event = updateToEvent(
			makeUpdate({ text: "/new", entities: [{ type: "bot_command", offset: 0, length: 4 }] }),
			BOT,
		);
		expect(event?.text).toBe("/new");
		expect(event?.metadata).toBeUndefined();
	});

	it("drops own messages and all bot messages (even ones mentioning us)", () => {
		expect(updateToEvent(makeUpdate({ text: "hi", fromId: BOT.botId }), BOT)).toBeNull();
		expect(updateToEvent(makeUpdate({ text: "hi", isBot: true }), BOT)).toBeNull();
		expect(
			updateToEvent(
				makeUpdate({
					text: "@lunrbot hi",
					isBot: true,
					entities: [{ type: "mention", offset: 0, length: 8 }],
				}),
				BOT,
			),
		).toBeNull();
	});

	it("drops media-only messages but accepts captions", () => {
		expect(updateToEvent(makeUpdate({}), BOT)).toBeNull();
		const event = updateToEvent(makeUpdate({ caption: "a photo" }), BOT);
		expect(event?.text).toBe("a photo");
	});

	it("drops non-message updates", () => {
		expect(updateToEvent({ update_id: 1 }, BOT)).toBeNull();
	});

	it("exposes reply_to_message.text, truncated to ~500 chars", () => {
		expect(updateToEvent(makeUpdate({ text: "x", replyText: "earlier" }), BOT)?.replyToText).toBe("earlier");
		const long = updateToEvent(makeUpdate({ text: "x", replyText: "y".repeat(600) }), BOT)?.replyToText;
		expect(long).toHaveLength(500);
	});

	it("falls back to first_name when username is missing", () => {
		const update = makeUpdate({ text: "x" });
		if (update.message?.from) {
			update.message.from.username = undefined;
			update.message.from.first_name = "Alice";
		}
		expect(updateToEvent(update, BOT)?.source.userName).toBe("Alice");
	});
});

describe("TelegramAdapter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function connectAdapter(api: MockApi): Promise<{ adapter: TelegramAdapter; events: MessageEvent[] }> {
		api.queue("getMe", { id: BOT.botId, username: BOT.botUsername });
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		const events: MessageEvent[] = [];
		adapter.onMessage((event) => events.push(event));
		await adapter.connect();
		return { adapter, events };
	}

	it("advances the offset across getUpdates batches and dispatches each update", async () => {
		const api = new MockApi();
		const u1 = makeUpdate({ text: "one", fromId: 1, updateId: 100 });
		const u2 = makeUpdate({ text: "two", fromId: 2, updateId: 101 });
		const u3 = makeUpdate({ text: "three", fromId: 3, updateId: 102 });
		api.queue("getUpdates", [u1, u2], [u3]);
		api.fallback = park;
		const { adapter, events } = await connectAdapter(api);
		await vi.advanceTimersByTimeAsync(300); // let both batches process + debounce flush
		const polls = api.callsFor("getUpdates");
		expect(polls[0]).toMatchObject({ offset: 0, timeout: 30, allowed_updates: ["message", "callback_query"] });
		expect(polls[1]).toMatchObject({ offset: 102 });
		expect(polls[2]).toMatchObject({ offset: 103 });
		expect(events.map((e) => e.text)).toEqual(["one", "two", "three"]);
		await adapter.disconnect();
	});

	it("debounces two rapid texts into one merged event (latest messageId kept)", async () => {
		const api = new MockApi();
		const u1 = makeUpdate({ text: "hello" });
		const u2 = makeUpdate({ text: "world" }); // same chat/user as u1
		api.queue("getUpdates", [u1, u2]);
		api.fallback = park;
		const { adapter, events } = await connectAdapter(api);
		await vi.advanceTimersByTimeAsync(0); // process the batch
		expect(events).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(299);
		expect(events).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(events).toHaveLength(1);
		expect(events[0].text).toBe("hello\nworld");
		expect(events[0].messageId).toBe(String(u2.message?.message_id));
		await adapter.disconnect();
	});

	it("flushes commands immediately without merging", async () => {
		const api = new MockApi();
		api.queue("getUpdates", [makeUpdate({ text: "hello" }), makeUpdate({ text: "/status" })]);
		api.fallback = park;
		const { adapter, events } = await connectAdapter(api);
		await vi.advanceTimersByTimeAsync(0); // process the batch
		expect(events.map((e) => e.text)).toEqual(["hello", "/status"]); // pending text flushed, then command
		await vi.advanceTimersByTimeAsync(1000);
		expect(events).toHaveLength(2); // nothing else pending
		await adapter.disconnect();
	});

	it("backs off after a poll error and retries", async () => {
		const api = new MockApi();
		api.queue("getUpdates", new Error("network down"));
		api.fallback = park;
		const { adapter } = await connectAdapter(api);
		await vi.advanceTimersByTimeAsync(0);
		expect(api.callsFor("getUpdates")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(api.callsFor("getUpdates")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1); // first backoff step: 1000ms
		expect(api.callsFor("getUpdates")).toHaveLength(2);
		await adapter.disconnect();
	});

	it("send passes thread/reply options and retries without parse_mode on Markdown errors", async () => {
		const api = new MockApi();
		api.queue("sendMessage", new TelegramApiError(400, "Bad Request: can't parse entities"), { message_id: 55 });
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		const result = await adapter.send("123", "hi *bold*", { replyTo: "7", threadId: "9" });
		expect(result).toEqual({ success: true, messageId: "55" });
		const sends = api.callsFor("sendMessage");
		expect(sends).toHaveLength(2);
		expect(sends[0]).toMatchObject({
			chat_id: "123",
			text: "hi *bold*",
			parse_mode: "Markdown",
			message_thread_id: 9,
			reply_parameters: { message_id: 7 },
		});
		expect("parse_mode" in sends[1]).toBe(false);
		expect(sends[1].text).toBe("hi *bold*");
	});

	it("send honors 429 retry_after, then succeeds", async () => {
		const api = new MockApi();
		api.queue("sendMessage", new TelegramApiError(429, "Too Many Requests", 2), { message_id: 9 });
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		const promise = adapter.send("1", "hi");
		await vi.advanceTimersByTimeAsync(1999);
		expect(api.callsFor("sendMessage")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(promise).resolves.toEqual({ success: true, messageId: "9" });
	});

	it("send retries 429 only once, then returns a retryable failure", async () => {
		const api = new MockApi();
		api.queue(
			"sendMessage",
			new TelegramApiError(429, "slow down", 1),
			new TelegramApiError(429, "still limited", 5),
		);
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		const promise = adapter.send("1", "hi");
		await vi.advanceTimersByTimeAsync(1000);
		const result = await promise;
		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(api.callsFor("sendMessage")).toHaveLength(2); // exactly one retry
	});

	it("editMessage treats 'message is not modified' as success", async () => {
		const api = new MockApi();
		api.queue("editMessageText", new TelegramApiError(400, "Bad Request: message is not modified"));
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await expect(adapter.editMessage("1", "5", "same")).resolves.toEqual({ success: true, messageId: "5" });
	});

	it("editMessage retries without parse_mode on Markdown errors", async () => {
		const api = new MockApi();
		api.queue("editMessageText", new TelegramApiError(400, "Bad Request: can't parse entities"), {});
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		const result = await adapter.editMessage("1", "5", "x_y");
		expect(result.success).toBe(true);
		const edits = api.callsFor("editMessageText");
		expect(edits).toHaveLength(2);
		expect("parse_mode" in edits[1]).toBe(false);
	});

	it("sendTyping refreshes every 4s and stops once send() completes", async () => {
		const api = new MockApi();
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await adapter.sendTyping("1");
		expect(api.callsFor("sendChatAction")).toHaveLength(1);
		expect(api.callsFor("sendChatAction")[0]).toMatchObject({ chat_id: "1", action: "typing" });
		await vi.advanceTimersByTimeAsync(4000);
		expect(api.callsFor("sendChatAction")).toHaveLength(2);
		api.queue("sendMessage", { message_id: 3 });
		await adapter.send("1", "done");
		await vi.advanceTimersByTimeAsync(12000);
		expect(api.callsFor("sendChatAction")).toHaveLength(2); // refresher stopped by send()
	});

	it("sendTyping auto-stops after 2 minutes without a refresh", async () => {
		const api = new MockApi();
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await adapter.sendTyping("1");
		await vi.advanceTimersByTimeAsync(121_000);
		const callsAtSafetyStop = api.callsFor("sendChatAction").length;
		expect(callsAtSafetyStop).toBeGreaterThan(1);
		await vi.advanceTimersByTimeAsync(12000);
		expect(api.callsFor("sendChatAction")).toHaveLength(callsAtSafetyStop); // interval cleared
	});

	it("backoffDelayMs follows 1s→2s→5s→10s→30s and caps", () => {
		expect(backoffDelayMs(0)).toBe(1000);
		expect(backoffDelayMs(1)).toBe(2000);
		expect(backoffDelayMs(2)).toBe(5000);
		expect(backoffDelayMs(3)).toBe(10000);
		expect(backoffDelayMs(4)).toBe(30000);
		expect(backoffDelayMs(99)).toBe(30000);
	});
});

describe("registerCommands", () => {
	it("calls setMyCommands with the exact command payload", async () => {
		const api = new MockApi();
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await adapter.registerCommands([
			{ name: "model", description: "list or switch models" },
			{ name: "new", description: "start a fresh session for this chat" },
		]);
		expect(api.callsFor("setMyCommands")).toEqual([
			{
				commands: [
					{ command: "model", description: "list or switch models" },
					{ command: "new", description: "start a fresh session for this chat" },
				],
			},
		]);
	});

	it("filters invalid names, trims and caps descriptions", async () => {
		const api = new MockApi();
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await adapter.registerCommands([
			{ name: "Has-Dash", description: "bad name" },
			{ name: "toolongcommandnamethatexceeds32chars", description: "bad name" },
			{ name: "ok", description: "   " },
			{ name: "good", description: `  ${"x".repeat(300)}  ` },
		]);
		expect(api.callsFor("setMyCommands")).toEqual([
			{ commands: [{ command: "good", description: "x".repeat(256) }] },
		]);
	});

	it("skips the API call when nothing valid remains", async () => {
		const api = new MockApi();
		const adapter = new TelegramAdapter(CFG, { callApi: api.callApi });
		await adapter.registerCommands([{ name: "NOPE", description: "bad" }]);
		expect(api.callsFor("setMyCommands")).toHaveLength(0);
	});
});
