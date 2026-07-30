import { ChannelType, Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiscordAdapter,
	type DiscordChannelLike,
	type DiscordClientLike,
	type DiscordMessageLike,
	messageToEvent,
	resetSeenMessageIds,
} from "../src/gateway/adapters/discord.ts";
import type { DiscordConfig } from "../src/gateway/config.ts";
import type { MessageEvent } from "../src/gateway/types.ts";

const BOT_ID = "777";

const CFG: DiscordConfig = {
	enabled: true,
	token: "test-token",
	allowedUsers: [],
	allowedChats: [],
	requireMention: true,
	freeResponseChats: [],
	ignoredChannels: [],
	autoThread: true,
};

function apiError(code: number, message: string): Error {
	return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class MockClient implements DiscordClientLike {
	user: { id: string } | null = null;
	loginTokens: string[] = [];
	loginError?: Error;
	destroyed = false;
	fetchCalls: string[] = [];
	readonly channelMap = new Map<string, DiscordChannelLike>();
	private listeners = new Map<string, Array<{ once: boolean; listener: (...args: unknown[]) => void }>>();

	login(token: string): Promise<unknown> {
		this.loginTokens.push(token);
		return this.loginError ? Promise.reject(this.loginError) : Promise.resolve("ok");
	}

	on(event: string, listener: (arg: unknown) => void): unknown {
		return this.addListener(event, listener, false);
	}

	once(event: string, listener: () => void): unknown {
		return this.addListener(event, listener as (arg: unknown) => void, true);
	}

	private addListener(event: string, listener: (arg: unknown) => void, once: boolean): this {
		const list = this.listeners.get(event) ?? [];
		list.push({ once, listener });
		this.listeners.set(event, list);
		return this;
	}

	emit(event: string, ...args: unknown[]): void {
		const list = this.listeners.get(event) ?? [];
		const keep: typeof list = [];
		for (const entry of list) {
			entry.listener(...args);
			if (!entry.once) keep.push(entry);
		}
		this.listeners.set(event, keep);
	}

	destroy(): void {
		this.destroyed = true;
	}

	channels = {
		fetch: (id: string): Promise<DiscordChannelLike | null> => {
			this.fetchCalls.push(id);
			const channel = this.channelMap.get(id);
			if (channel === undefined) return Promise.reject(apiError(10003, "Unknown Channel"));
			return Promise.resolve(channel);
		},
	};
}

/** A sendable channel recording sends, edits and typing calls. */
function fakeChannel(id: string, type: number) {
	const sent: Array<{ content: string; reply?: { messageReference: string } }> = [];
	const edits: Array<{ id: string; text: string }> = [];
	const stored = new Map<string, { content: string }>();
	const failNextSends: Error[] = [];
	let typingCount = 0;
	const channel: DiscordChannelLike = {
		id,
		type,
		parentId: null,
		send: (payload) => {
			const err = failNextSends.shift();
			if (err) return Promise.reject(err);
			sent.push(payload);
			return Promise.resolve({ id: `sent-${sent.length}` });
		},
		sendTyping: () => {
			typingCount += 1;
			return Promise.resolve();
		},
		messages: {
			fetch: (messageId: string) => {
				const found = stored.get(messageId);
				if (!found) return Promise.reject(apiError(10008, "Unknown Message"));
				return Promise.resolve({
					content: found.content,
					edit: (options: string | { content: string; components?: unknown[] }) => {
						edits.push({ id: messageId, text: typeof options === "string" ? options : options.content });
						return Promise.resolve();
					},
				});
			},
		},
	};
	return {
		channel,
		sent,
		edits,
		stored,
		failNextSends,
		get typingCount() {
			return typingCount;
		},
	};
}

let nextId = 1000;

interface MsgOptions {
	content?: string;
	channelType?: number;
	channelId?: string;
	parentId?: string | null;
	authorId?: string;
	bot?: boolean;
	username?: string;
	system?: boolean;
	mentionBot?: boolean;
	messageId?: string;
	referenceId?: string;
	cachedReply?: string;
	startThread?: (opts: { name: string; autoArchiveDuration: number }) => Promise<DiscordChannelLike>;
}

function makeMessage(options: MsgOptions = {}): DiscordMessageLike {
	const channel: DiscordChannelLike = {
		id: options.channelId ?? "555",
		type: options.channelType ?? ChannelType.DM,
		parentId: options.parentId ?? null,
	};
	if (options.cachedReply !== undefined) {
		channel.messages = {
			cache: { get: () => ({ content: options.cachedReply }) },
			fetch: () => Promise.reject(new Error("should not fetch — cache hit")),
		};
	}
	const message: DiscordMessageLike = {
		id: options.messageId ?? String(++nextId),
		content: options.content,
		system: options.system ?? false,
		author: { id: options.authorId ?? "42", bot: options.bot, username: options.username ?? "alice" },
		channel,
		reference: options.referenceId !== undefined ? { messageId: options.referenceId } : null,
		mentions: {
			has: (user) => user.id === BOT_ID && options.mentionBot === true,
			repliedUser: null,
		},
	};
	if (options.startThread) message.startThread = options.startThread;
	return message;
}

// ---------------------------------------------------------------------------
// messageToEvent (pure mapping)
// ---------------------------------------------------------------------------

describe("messageToEvent", () => {
	it("maps a DM text message", () => {
		const event = messageToEvent(makeMessage({ content: "hi" }), { id: BOT_ID });
		expect(event).not.toBeNull();
		expect(event?.text).toBe("hi");
		expect(event?.source).toEqual({
			platform: "discord",
			chatId: "555",
			chatType: "dm",
			userId: "42",
			userName: "alice",
			threadId: undefined,
		});
		expect(event?.metadata).toBeUndefined();
	});

	it("maps guild text and announcement channels to group with chatId = channel id", () => {
		const text = messageToEvent(makeMessage({ content: "x", channelType: ChannelType.GuildText }), { id: BOT_ID });
		expect(text?.source.chatType).toBe("group");
		expect(text?.source.chatId).toBe("555");
		expect(text?.source.threadId).toBeUndefined();
		const announcement = messageToEvent(makeMessage({ content: "x", channelType: ChannelType.GuildAnnouncement }), {
			id: BOT_ID,
		});
		expect(announcement?.source.chatType).toBe("group");
	});

	it("maps threads to chatType thread with chatId = parent id and threadId = channel id", () => {
		const event = messageToEvent(
			makeMessage({ content: "x", channelType: ChannelType.PublicThread, channelId: "t1", parentId: "555" }),
			{ id: BOT_ID },
		);
		expect(event?.source.chatType).toBe("thread");
		expect(event?.source.chatId).toBe("555");
		expect(event?.source.threadId).toBe("t1");
	});

	it("drops unsupported channel types", () => {
		expect(
			messageToEvent(makeMessage({ content: "x", channelType: ChannelType.GuildVoice }), { id: BOT_ID }),
		).toBeNull();
	});

	it("drops own, other-bot, system and empty/attachment-only messages", () => {
		expect(messageToEvent(makeMessage({ content: "hi", authorId: BOT_ID }), { id: BOT_ID })).toBeNull();
		expect(messageToEvent(makeMessage({ content: "hi", bot: true }), { id: BOT_ID })).toBeNull();
		expect(
			messageToEvent(
				makeMessage({ content: "hi", bot: true, mentionBot: true, channelType: ChannelType.GuildText }),
				{
					id: BOT_ID,
				},
			),
		).toBeNull();
		expect(messageToEvent(makeMessage({ content: "hi", system: true }), { id: BOT_ID })).toBeNull();
		expect(messageToEvent(makeMessage({}), { id: BOT_ID })).toBeNull();
		expect(messageToEvent(makeMessage({ content: "   " }), { id: BOT_ID })).toBeNull();
	});

	it("detects a bot mention, strips <@id> and <@!id> forms, and trims", () => {
		const plain = messageToEvent(
			makeMessage({ content: `<@${BOT_ID}> hello there`, mentionBot: true, channelType: ChannelType.GuildText }),
			{ id: BOT_ID },
		);
		expect(plain?.text).toBe("hello there");
		expect(plain?.metadata).toEqual({ mentionedBot: true });
		const nicknamed = messageToEvent(
			makeMessage({ content: `<@!${BOT_ID}> ping`, mentionBot: true, channelType: ChannelType.GuildText }),
			{ id: BOT_ID },
		);
		expect(nicknamed?.text).toBe("ping");
		expect(nicknamed?.metadata).toEqual({ mentionedBot: true });
	});

	it("drops non-DM messages mentioning others but not us (multi-agent filter)", () => {
		expect(
			messageToEvent(makeMessage({ content: "<@999> hello", channelType: ChannelType.GuildText }), { id: BOT_ID }),
		).toBeNull();
		// Same content in a DM is always for us.
		const dm = messageToEvent(makeMessage({ content: "<@999> hello" }), { id: BOT_ID });
		expect(dm).not.toBeNull();
		expect(dm?.metadata).toBeUndefined();
		// A message mentioning us AND someone else is kept.
		const both = messageToEvent(
			makeMessage({ content: `<@${BOT_ID}> <@999> hello`, mentionBot: true, channelType: ChannelType.GuildText }),
			{ id: BOT_ID },
		);
		expect(both?.text).toBe("<@999> hello");
		expect(both?.metadata).toEqual({ mentionedBot: true });
	});

	it("treats messages in threads the bot participates in as mentionedBot", () => {
		const inThread = makeMessage({
			content: "follow-up, no mention",
			channelType: ChannelType.PublicThread,
			channelId: "t1",
			parentId: "555",
		});
		const cold = messageToEvent(inThread, { id: BOT_ID });
		expect(cold?.metadata).toBeUndefined();
		const warm = messageToEvent(inThread, { id: BOT_ID }, { participatingThreads: new Set(["t1"]) });
		expect(warm?.metadata).toEqual({ mentionedBot: true });
	});

	it("drops messages in ignoredChannels (own id or parent id), even when mentioned", () => {
		const mentioned = () =>
			makeMessage({ content: `<@${BOT_ID}> hi`, mentionBot: true, channelType: ChannelType.GuildText });
		expect(messageToEvent(mentioned(), { id: BOT_ID }, { ignoredChannels: ["555"] })).toBeNull();
		const inThread = makeMessage({
			content: `<@${BOT_ID}> hi`,
			mentionBot: true,
			channelType: ChannelType.PublicThread,
			channelId: "t1",
			parentId: "555",
		});
		expect(messageToEvent(inThread, { id: BOT_ID }, { ignoredChannels: ["555"] })).toBeNull(); // parent ignored
		expect(
			messageToEvent(
				makeMessage({
					content: "hi",
					channelType: ChannelType.PublicThread,
					channelId: "t1",
					parentId: "555",
				}),
				{ id: BOT_ID },
				{ ignoredChannels: ["t1"] },
			),
		).toBeNull(); // thread itself ignored
	});

	it("exposes a cached replied-to message, truncated to ~500 chars", () => {
		const event = messageToEvent(makeMessage({ content: "x", referenceId: "9", cachedReply: "earlier" }), {
			id: BOT_ID,
		});
		expect(event?.replyToText).toBe("earlier");
		const long = messageToEvent(makeMessage({ content: "x", referenceId: "9", cachedReply: "y".repeat(600) }), {
			id: BOT_ID,
		});
		expect(long?.replyToText).toHaveLength(500);
	});
});

// ---------------------------------------------------------------------------
// DiscordAdapter
// ---------------------------------------------------------------------------

describe("DiscordAdapter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetSeenMessageIds();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function connectAdapter(
		client: MockClient,
		cfg: DiscordConfig = CFG,
	): Promise<{ adapter: DiscordAdapter; events: MessageEvent[] }> {
		const adapter = new DiscordAdapter(cfg, { clientFactory: () => client });
		const events: MessageEvent[] = [];
		adapter.onMessage((event) => events.push(event));
		const connectPromise = adapter.connect();
		client.user = { id: BOT_ID };
		client.emit(Events.ClientReady);
		await connectPromise;
		return { adapter, events };
	}

	it("throws without a token when no clientFactory is injected", () => {
		expect(() => new DiscordAdapter({ ...CFG, token: undefined })).toThrow(/no bot token/);
	});

	it("connect logs in with the token and resolves true on clientReady", async () => {
		const client = new MockClient();
		const { adapter } = await connectAdapter(client);
		expect(client.loginTokens).toEqual(["test-token"]);
		await adapter.disconnect();
		expect(client.destroyed).toBe(true);
	});

	it("connect resolves false when login fails", async () => {
		const client = new MockClient();
		client.loginError = new Error("invalid token");
		const adapter = new DiscordAdapter(CFG, { clientFactory: () => client });
		await expect(adapter.connect()).resolves.toBe(false);
	});

	it("drops gateway-resume replays (same message id delivered twice)", async () => {
		const client = new MockClient();
		const { adapter, events } = await connectAdapter(client);
		const message = makeMessage({ content: "hello" });
		client.emit(Events.MessageCreate, message);
		client.emit(Events.MessageCreate, message);
		await vi.advanceTimersByTimeAsync(600);
		expect(events).toHaveLength(1);
		await adapter.disconnect();
	});

	it("debounces two rapid texts into one merged event (latest messageId kept)", async () => {
		const client = new MockClient();
		const { adapter, events } = await connectAdapter(client);
		const first = makeMessage({ content: "hello" });
		const second = makeMessage({ content: "world" }); // same chat/user
		client.emit(Events.MessageCreate, first);
		client.emit(Events.MessageCreate, second);
		await vi.advanceTimersByTimeAsync(599);
		expect(events).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(events).toHaveLength(1);
		expect(events[0].text).toBe("hello\nworld");
		expect(events[0].messageId).toBe(second.id);
		await adapter.disconnect();
	});

	it("flushes commands immediately without merging", async () => {
		const client = new MockClient();
		const { adapter, events } = await connectAdapter(client);
		client.emit(Events.MessageCreate, makeMessage({ content: "hello" }));
		client.emit(Events.MessageCreate, makeMessage({ content: "/status" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(events.map((e) => e.text)).toEqual(["hello", "/status"]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(events).toHaveLength(2);
		await adapter.disconnect();
	});

	it("autoThread creates a thread for a guild-text mention and re-targets the event", async () => {
		const client = new MockClient();
		const thread: DiscordChannelLike = { id: "t1", type: ChannelType.PublicThread, parentId: "555" };
		const startThread = vi.fn(() => Promise.resolve(thread));
		const { adapter, events } = await connectAdapter(client);
		client.emit(
			Events.MessageCreate,
			makeMessage({
				content: `<@${BOT_ID}> hello discord world`,
				mentionBot: true,
				channelType: ChannelType.GuildText,
				startThread,
			}),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(startThread).toHaveBeenCalledWith({ name: "hello discord world", autoArchiveDuration: 60 });
		expect(events).toHaveLength(1);
		expect(events[0].source).toMatchObject({ chatType: "thread", chatId: "555", threadId: "t1" });
		expect(events[0].metadata).toEqual({ mentionedBot: true });

		// The created thread is now "warm": a follow-up without a mention still counts.
		client.emit(
			Events.MessageCreate,
			makeMessage({ content: "follow-up", channelType: ChannelType.PublicThread, channelId: "t1", parentId: "555" }),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(events).toHaveLength(2);
		expect(events[1].metadata).toEqual({ mentionedBot: true });
		await adapter.disconnect();
	});

	it("autoThread falls back to in-channel delivery when startThread fails", async () => {
		const client = new MockClient();
		const startThread = vi.fn(() => Promise.reject(new Error("Missing Permissions")));
		const { adapter, events } = await connectAdapter(client);
		client.emit(
			Events.MessageCreate,
			makeMessage({
				content: `<@${BOT_ID}> hi`,
				mentionBot: true,
				channelType: ChannelType.GuildText,
				startThread,
			}),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(events).toHaveLength(1);
		expect(events[0].source).toMatchObject({ chatType: "group", chatId: "555", threadId: undefined });
		await adapter.disconnect();
	});

	it("autoThread does not trigger without a mention or when disabled", async () => {
		const client = new MockClient();
		const startThread = vi.fn(() => Promise.reject(new Error("must not be called")));
		const { adapter, events } = await connectAdapter(client, { ...CFG, autoThread: false });
		client.emit(
			Events.MessageCreate,
			makeMessage({ content: `<@${BOT_ID}> hi`, mentionBot: true, channelType: ChannelType.GuildText, startThread }),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(startThread).not.toHaveBeenCalled();
		expect(events[0].source.chatType).toBe("group");
		await adapter.disconnect();
	});

	it("send targets the thread channel when threadId is given", async () => {
		const client = new MockClient();
		const thread = fakeChannel("t1", ChannelType.PublicThread);
		client.channelMap.set("t1", thread.channel);
		const { adapter } = await connectAdapter(client);
		const result = await adapter.send("555", "hi", { threadId: "t1" });
		expect(result).toEqual({ success: true, messageId: "sent-1" });
		expect(client.fetchCalls).toContain("t1");
		expect(thread.sent).toEqual([{ content: "hi", reply: undefined }]);
		await adapter.disconnect();
	});

	it("send passes a reply reference and falls back to a plain send when it fails", async () => {
		const client = new MockClient();
		const channel = fakeChannel("555", ChannelType.DM);
		channel.failNextSends.push(apiError(10008, "Unknown Message"));
		client.channelMap.set("555", channel.channel);
		const { adapter } = await connectAdapter(client);
		const result = await adapter.send("555", "hi", { replyTo: "7" });
		expect(result).toEqual({ success: true, messageId: "sent-1" });
		expect(channel.sent).toHaveLength(1); // first attempt rejected before recording
		expect(channel.sent[0]).toEqual({ content: "hi", reply: undefined });
		await adapter.disconnect();
	});

	it("send reports 50035 (invalid form body) as non-retryable", async () => {
		const client = new MockClient();
		const channel = fakeChannel("555", ChannelType.DM);
		channel.failNextSends.push(apiError(50035, "Invalid Form Body"));
		client.channelMap.set("555", channel.channel);
		const { adapter } = await connectAdapter(client);
		const result = await adapter.send("555", "x".repeat(5000));
		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		await adapter.disconnect();
	});

	it("send records thread participation (follow-ups count as mentionedBot)", async () => {
		const client = new MockClient();
		const thread = fakeChannel("t1", ChannelType.PublicThread);
		client.channelMap.set("t1", thread.channel);
		const { adapter, events } = await connectAdapter(client);
		await adapter.send("555", "hello thread", { threadId: "t1" });
		client.emit(
			Events.MessageCreate,
			makeMessage({ content: "follow-up", channelType: ChannelType.PublicThread, channelId: "t1", parentId: "555" }),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(events).toHaveLength(1);
		expect(events[0].metadata).toEqual({ mentionedBot: true });
		await adapter.disconnect();
	});

	it("editMessage edits via the channel recorded at send time (thread messages)", async () => {
		const client = new MockClient();
		const thread = fakeChannel("t1", ChannelType.PublicThread);
		client.channelMap.set("t1", thread.channel);
		const { adapter } = await connectAdapter(client);
		const sent = await adapter.send("555", "draft", { threadId: "t1" });
		thread.stored.set("sent-1", { content: "draft" });
		const result = await adapter.editMessage("555", sent.messageId ?? "", "final");
		expect(result).toEqual({ success: true, messageId: "sent-1" });
		expect(thread.edits).toEqual([{ id: "sent-1", text: "final" }]);
		await adapter.disconnect();
	});

	it("editMessage treats Unknown Message (10008) as a terminal failure", async () => {
		const client = new MockClient();
		const channel = fakeChannel("555", ChannelType.DM);
		client.channelMap.set("555", channel.channel);
		const { adapter } = await connectAdapter(client);
		const result = await adapter.editMessage("555", "gone", "text");
		expect(result.success).toBe(false);
		expect(result.retryable).toBeUndefined();
		await adapter.disconnect();
	});

	it("sendTyping refreshes every 8s and stops once send() completes", async () => {
		const client = new MockClient();
		const channel = fakeChannel("555", ChannelType.DM);
		client.channelMap.set("555", channel.channel);
		const { adapter } = await connectAdapter(client);
		await adapter.sendTyping("555");
		expect(channel.typingCount).toBe(1);
		await vi.advanceTimersByTimeAsync(8000);
		expect(channel.typingCount).toBe(2);
		await adapter.send("555", "done");
		await vi.advanceTimersByTimeAsync(24000);
		expect(channel.typingCount).toBe(2); // refresher stopped by send()
		await adapter.disconnect();
	});

	it("sendTyping targets the thread channel and auto-stops after 2 minutes", async () => {
		const client = new MockClient();
		const thread = fakeChannel("t1", ChannelType.PublicThread);
		client.channelMap.set("t1", thread.channel);
		const { adapter } = await connectAdapter(client);
		await adapter.sendTyping("555", "t1");
		expect(client.fetchCalls).toContain("t1");
		expect(thread.typingCount).toBe(1);
		await vi.advanceTimersByTimeAsync(121_000);
		const atSafetyStop = thread.typingCount;
		expect(atSafetyStop).toBeGreaterThan(1);
		await vi.advanceTimersByTimeAsync(24000);
		expect(thread.typingCount).toBe(atSafetyStop); // interval cleared by the safety net
		await adapter.disconnect();
	});
});
