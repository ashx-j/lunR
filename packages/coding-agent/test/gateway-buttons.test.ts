import { ChannelType, Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buttonInteractionToEvent,
	DiscordAdapter,
	type DiscordButtonInteractionLike,
	type DiscordChannelLike,
	type DiscordClientLike,
} from "../src/gateway/adapters/discord.ts";
import { callbackQueryToEvent, TelegramAdapter, type TelegramCallbackQuery } from "../src/gateway/adapters/telegram.ts";
import {
	activePickerIds,
	createPicker,
	handleCallback,
	resetButtonRegistry,
	startButtonSweeper,
	stopButtonSweeper,
} from "../src/gateway/buttons.ts";
import { CHAT_COMMANDS, type ChatCommandContext, runChatCommand, sendCommandReply } from "../src/gateway/commands.ts";
import type {
	ButtonSpec,
	CallbackEvent,
	MessageEvent,
	PlatformAdapter,
	SendOptions,
	SendResult,
	SessionSource,
} from "../src/gateway/types.ts";

// ---------------------------------------------------------------------------
// Generic test adapter
// ---------------------------------------------------------------------------

class FakeAdapter implements PlatformAdapter {
	readonly platform = "telegram";
	maxMessageLength = 4000;
	sent: Array<{ chatId: string; text: string; opts?: SendOptions }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string; opts?: SendOptions }> = [];
	callbackAnswers: CallbackEvent[] = [];
	private callbackHandler?: (event: CallbackEvent) => void;

	async connect(): Promise<boolean> {
		return true;
	}
	async disconnect(): Promise<void> {}
	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts });
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async sendButtons(chatId: string, text: string, buttons: ButtonSpec, opts?: SendOptions): Promise<SendResult> {
		return this.send(chatId, text, { ...opts, buttons });
	}
	async editMessage(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		this.edits.push({ chatId, messageId, text, opts });
		return { success: true };
	}
	async sendTyping(): Promise<void> {}
	onMessage(): void {}
	onCallback(handler: (event: CallbackEvent) => void): void {
		this.callbackHandler = handler;
	}
	async answerCallback(event: CallbackEvent): Promise<void> {
		this.callbackAnswers.push(event);
	}
	simulateCallback(event: CallbackEvent): void {
		this.callbackHandler?.(event);
	}
}

function makeSource(overrides: Partial<SessionSource> = {}): SessionSource {
	return {
		platform: "telegram",
		chatId: "chat1",
		chatType: "dm",
		userId: "u1",
		...overrides,
	};
}

function makeEvent(text: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
	return {
		text,
		messageId: "msg1",
		source: makeSource(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Registry + picker
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetButtonRegistry();
});

afterEach(() => {
	resetButtonRegistry();
	vi.restoreAllMocks();
});

describe("button registry", () => {
	it("createPicker registers an entry and handleCallback selects an item", async () => {
		const adapter = new FakeAdapter();
		const selected: string[] = [];
		await createPicker(
			{ event: makeEvent("/model"), adapter, key: "k1" },
			{
				command: "model",
				items: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				],
				async onSelect(item) {
					selected.push(item.id);
				},
			},
		);
		expect(adapter.sent[0].text).toContain("Pick a model");
		expect(adapter.sent[0].opts?.buttons).toBeDefined();
		expect(activePickerIds()).toHaveLength(1);

		const targetButton = adapter.sent[0].opts?.buttons?.flat().find((b) => b.label === "B");
		expect(targetButton).toBeDefined();
		await handleCallback(
			{
				source: makeSource(),
				messageId: adapter.sent[0].messageId ?? "m1",
				buttonId: targetButton!.id,
				callbackId: "cb1",
			},
			adapter,
		);

		expect(adapter.answerCallback).toHaveLength(1);
		expect(selected).toEqual(["b"]);
		expect(activePickerIds()).toHaveLength(0);
		// Original picker message is cleared of buttons.
		expect(adapter.edits[0].text).toContain("Selected: B");
		expect(adapter.edits[0].opts?.buttons).toEqual([]);
	});

	it("handleCallback pages prev/next", async () => {
		const adapter = new FakeAdapter();
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));
		await createPicker(
			{ event: makeEvent("/model"), adapter, key: "k1" },
			{ command: "item", items, async onSelect() {} },
		);
		const messageId = adapter.sent[0].messageId ?? "m1";
		const nextButton = adapter.sent[0].opts?.buttons?.flat().find((b) => b.label === "Next ▶");
		expect(nextButton).toBeDefined();

		await handleCallback({ source: makeSource(), messageId, buttonId: nextButton!.id, callbackId: "cb2" }, adapter);
		expect(adapter.edits[0].text).toContain("(2/2)");
		const prevButton = adapter.edits[0].opts?.buttons?.flat().find((b) => b.label === "◀ Prev");
		expect(prevButton).toBeDefined();

		await handleCallback({ source: makeSource(), messageId, buttonId: prevButton!.id, callbackId: "cb3" }, adapter);
		expect(adapter.edits[1].text).toContain("(1/2)");
	});

	it("ignores callbacks from a different user", async () => {
		const adapter = new FakeAdapter();
		await createPicker(
			{ event: makeEvent("/model"), adapter, key: "k1" },
			{
				command: "model",
				items: [{ id: "a", label: "A" }],
				async onSelect() {},
			},
		);
		const messageId = adapter.sent[0].messageId ?? "m1";
		const target = adapter.sent[0].opts?.buttons?.flat()[0];
		const spy = vi.fn();
		adapter.onCallback(spy);
		await handleCallback(
			{
				source: makeSource({ userId: "u2" }),
				messageId,
				buttonId: target!.id,
				callbackId: "cb4",
			},
			adapter,
		);
		expect(spy).not.toHaveBeenCalled();
		expect(activePickerIds()).toHaveLength(1);
	});

	it("TTL sweeper removes expired entries", () => {
		vi.useFakeTimers();
		startButtonSweeper();
		const adapter = new FakeAdapter();
		void createPicker(
			{ event: makeEvent("/model"), adapter, key: "k1" },
			{ command: "model", items: [{ id: "a", label: "A" }], async onSelect() {} },
		);
		void vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
		expect(activePickerIds()).toHaveLength(0);
		stopButtonSweeper();
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// Commands picker integration
// ---------------------------------------------------------------------------

function fakeModel(id: string, provider = "ollama-cloud", reasoning = false) {
	return {
		id,
		provider,
		api: "openai" as const,
		contextWindow: 131_072,
		reasoning: reasoning ? ({ maxBudget: 1000 } as unknown as Record<string, unknown>) : undefined,
	};
}

function createFakeSession(): any {
	let thinking = "off";
	let model = fakeModel("deepseek-v4-flash");
	return {
		model,
		modelRuntime: {
			refresh: vi.fn().mockResolvedValue(undefined),
			getAvailable: vi
				.fn()
				.mockResolvedValue([
					fakeModel("deepseek-v4-flash"),
					fakeModel("qwen-2.5-72b"),
					fakeModel("claude-opus-4", "anthropic", true),
				]),
		},
		setModel: vi.fn().mockImplementation((m) => {
			model = m;
			return Promise.resolve();
		}),
		getAvailableThinkingLevels: () => (model.reasoning ? ["off", "low", "high"] : ["off"]),
		supportsThinking: () => !!model.reasoning,
		setThinkingLevel: (level: string) => {
			thinking = level;
		},
		get thinkingLevel() {
			return thinking;
		},
	};
}

function makeCommandCtx(text: string): ChatCommandContext {
	const event = makeEvent(text);
	const adapter = new FakeAdapter();
	const bridge = {
		getStatus: () => ({ busy: false, queueDepth: 0 }),
		getSession: vi.fn().mockResolvedValue(createFakeSession()),
	} as unknown as import("../src/gateway/router.ts").BridgeLike;
	const trimmed = event.text.trim();
	const firstToken = trimmed.split(/\s+/, 1)[0].toLowerCase();
	const args = trimmed.slice(firstToken.length).trim();
	return {
		event,
		key: "k1",
		adapter,
		bridge,
		args,
		reply: (message: string) => sendCommandReply(adapter, event, message),
	};
}

describe("command picker integration", () => {
	it("/model with no args renders a picker that selects a model", async () => {
		const ctx = makeCommandCtx("/model");
		const cmd = CHAT_COMMANDS.find((c) => c.name === "model")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		const target = adapter.sent[0].opts?.buttons?.flat().find((b) => b.label?.includes("qwen"));
		expect(target).toBeDefined();
		await handleCallback(
			{
				source: ctx.event.source,
				messageId: adapter.sent[0].messageId ?? "m1",
				buttonId: target!.id,
				callbackId: "cb5",
			},
			adapter,
		);
		expect(adapter.sent.some((m) => m.text.includes("Model → ollama-cloud/qwen-2.5-72b"))).toBe(true);
	});

	it("/model with args still uses the direct text path", async () => {
		const ctx = makeCommandCtx("/model qwen");
		const cmd = CHAT_COMMANDS.find((c) => c.name === "model")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		expect(adapter.sent[0].opts?.buttons).toBeUndefined();
		expect(adapter.sent[0].text).toContain("Model →");
	});
});

// ---------------------------------------------------------------------------
// Telegram adapter
// ---------------------------------------------------------------------------

describe("TelegramAdapter buttons", () => {
	function makeCallApi() {
		return vi.fn(async (method: string, _body: Record<string, unknown>) => {
			if (method === "sendMessage") return { message_id: 42 };
			if (method === "editMessageText") return true;
			if (method === "answerCallbackQuery") return true;
			return {};
		});
	}

	function makeQuery(data: string, messageId = 7): TelegramCallbackQuery {
		return {
			id: "cq1",
			from: { id: 101, username: "alice" },
			message: {
				message_id: messageId,
				chat: { id: 1, type: "private" },
				from: { id: 101 },
			},
			data,
		};
	}

	it("sendButtons encodes ButtonSpec as inline_keyboard", async () => {
		const callApi = makeCallApi();
		const adapter = new TelegramAdapter({ enabled: true, token: "x" }, { callApi });
		const buttons: ButtonSpec = [[{ id: "b1", label: "One" }]];
		await adapter.sendButtons("1", "pick", buttons);
		expect(callApi).toHaveBeenCalledWith(
			"sendMessage",
			expect.objectContaining({
				chat_id: "1",
				text: "pick",
				reply_markup: {
					inline_keyboard: [[{ text: "One", callback_data: "b1" }]],
				},
			}),
		);
	});

	it("editMessage with buttons updates reply_markup", async () => {
		const callApi = makeCallApi();
		const adapter = new TelegramAdapter({ enabled: true, token: "x" }, { callApi });
		const buttons: ButtonSpec = [[{ id: "b2", label: "Two" }]];
		await adapter.editMessage("1", "7", "updated", { buttons });
		expect(callApi).toHaveBeenCalledWith(
			"editMessageText",
			expect.objectContaining({
				message_id: 7,
				text: "updated",
				reply_markup: {
					inline_keyboard: [[{ text: "Two", callback_data: "b2" }]],
				},
			}),
		);
	});

	it("answerCallback calls answerCallbackQuery", async () => {
		const callApi = makeCallApi();
		const adapter = new TelegramAdapter({ enabled: true, token: "x" }, { callApi });
		await adapter.answerCallback({
			callbackId: "cq1",
			buttonId: "b1",
			messageId: "7",
			source: makeSource(),
		});
		expect(callApi).toHaveBeenCalledWith("answerCallbackQuery", { callback_query_id: "cq1" });
	});

	it("callbackQueryToEvent maps a query to a CallbackEvent", () => {
		const event = callbackQueryToEvent(makeQuery("b1"));
		expect(event).not.toBeNull();
		expect(event?.callbackId).toBe("cq1");
		expect(event?.buttonId).toBe("b1");
		expect(event?.messageId).toBe("7");
		expect(event?.source.userId).toBe("101");
	});
});

// ---------------------------------------------------------------------------
// Discord adapter
// ---------------------------------------------------------------------------

class MockClient implements DiscordClientLike {
	user: { id: string } | null = null;
	loginTokens: string[] = [];
	destroyed = false;
	channelMap = new Map<string, DiscordChannelLike>();
	private listeners = new Map<string, Array<(arg: unknown) => void>>();

	async login(token: string): Promise<unknown> {
		this.loginTokens.push(token);
		return "ok";
	}

	on(event: string, listener: (arg: unknown) => void): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		return this;
	}

	once(event: string, listener: () => void): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener as (arg: unknown) => void);
		this.listeners.set(event, list);
		return this;
	}

	emit(event: string, arg: unknown): void {
		const list = this.listeners.get(event) ?? [];
		for (const listener of list) listener(arg);
	}

	destroy(): void {
		this.destroyed = true;
	}

	channels = {
		fetch: async (id: string): Promise<DiscordChannelLike | null> => {
			return this.channelMap.get(id) ?? null;
		},
	};
}

function fakeChannel(id: string) {
	const sent: Array<{ content: string; reply?: { messageReference: string }; components?: unknown[] }> = [];
	const channel: DiscordChannelLike = {
		id,
		type: ChannelType.GuildText,
		parentId: null,
		send: async (payload) => {
			sent.push(payload);
			return { id: `sent-${sent.length}` };
		},
	};
	return { channel, sent };
}

const BOT_ID = "777";

describe("DiscordAdapter buttons", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function connectAdapter(client: MockClient): Promise<DiscordAdapter> {
		const adapter = new DiscordAdapter(
			{
				enabled: true,
				token: "test-token",
				allowedUsers: [],
				allowedChats: [],
				requireMention: false,
				freeResponseChats: [],
				ignoredChannels: [],
				autoThread: false,
			},
			{ clientFactory: () => client },
		);
		const connectPromise = adapter.connect();
		client.user = { id: BOT_ID };
		client.emit(Events.ClientReady);
		await connectPromise;
		return adapter;
	}

	function makeButtonInteraction(customId: string, messageId = "m1", channelId = "555"): DiscordButtonInteractionLike {
		return {
			id: `int-${customId}`,
			customId,
			user: { id: "42", username: "alice" },
			message: {
				id: messageId,
				channel: { id: channelId, type: ChannelType.GuildText, parentId: null },
			},
			isButton: () => true,
			deferUpdate: vi.fn().mockResolvedValue(undefined),
		};
	}

	it("sendButtons builds Discord action rows", async () => {
		const client = new MockClient();
		const { channel, sent } = fakeChannel("555");
		client.channelMap.set("555", channel);
		const adapter = await connectAdapter(client);
		const buttons: ButtonSpec = [
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			[{ id: "c", label: "C" }],
		];
		await adapter.sendButtons("555", "choose", buttons);
		expect(sent).toHaveLength(1);
		const components = sent[0].components ?? [];
		expect(components.length).toBe(2);
		const firstRow = components[0] as { components: { data: { custom_id: string; label: string } }[] };
		expect(firstRow.components[0].data.custom_id).toBe("a");
		expect(firstRow.components[0].data.label).toBe("A");
		await adapter.disconnect();
	});

	it("routes button interactions through onCallback", async () => {
		const client = new MockClient();
		const adapter = await connectAdapter(client);
		const events: CallbackEvent[] = [];
		adapter.onCallback((event) => events.push(event));
		const interaction = makeButtonInteraction("picker:x:select:0");
		client.emit(Events.InteractionCreate, interaction);
		expect(events).toHaveLength(1);
		expect(events[0].buttonId).toBe("picker:x:select:0");
		expect(events[0].callbackId).toBe("int-picker:x:select:0");
		await adapter.disconnect();
	});

	it("answerCallback defers the stored interaction", async () => {
		const client = new MockClient();
		const adapter = await connectAdapter(client);
		adapter.onCallback(() => {});
		const interaction = makeButtonInteraction("picker:x:select:0");
		client.emit(Events.InteractionCreate, interaction);
		await adapter.answerCallback({
			source: makeSource({ platform: "discord" }),
			messageId: "m1",
			buttonId: "picker:x:select:0",
			callbackId: "int-picker:x:select:0",
		});
		expect(interaction.deferUpdate).toHaveBeenCalled();
		await adapter.disconnect();
	});

	it("buttonInteractionToEvent maps channel type and user", () => {
		const event = buttonInteractionToEvent(makeButtonInteraction("btn"));
		expect(event).not.toBeNull();
		expect(event?.source.platform).toBe("discord");
		expect(event?.source.chatType).toBe("group");
		expect(event?.source.userId).toBe("42");
		expect(event?.buttonId).toBe("btn");
	});
});
