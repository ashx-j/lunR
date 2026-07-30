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
	type PickerItem,
	resetButtonRegistry,
	startButtonSweeper,
	stopButtonSweeper,
} from "../src/gateway/buttons.ts";
import { CHAT_COMMANDS, type ChatCommandContext, runChatCommand, sendCommandReply } from "../src/gateway/commands.ts";
import { defaultGatewayConfig } from "../src/gateway/config.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
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
	sent: Array<{ chatId: string; text: string; opts?: SendOptions; buttons?: ButtonSpec[][] }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string; buttons?: ButtonSpec[][] }> = [];
	callbackAnswers: Array<{ id: string; text?: string }> = [];
	private callbackHandler?: (event: CallbackEvent) => void;
	failNextSend = false;

	async connect(): Promise<boolean> {
		return true;
	}
	async disconnect(): Promise<void> {}
	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts });
		if (this.failNextSend) {
			this.failNextSend = false;
			return { success: false, error: "send failed" };
		}
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async sendButtons(chatId: string, text: string, buttons: ButtonSpec[][], opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts, buttons });
		if (this.failNextSend) {
			this.failNextSend = false;
			return { success: false, error: "sendButtons failed" };
		}
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async editMessage(chatId: string, messageId: string, text: string, buttons?: ButtonSpec[][]): Promise<SendResult> {
		this.edits.push({ chatId, messageId, text, buttons });
		return { success: true };
	}
	async sendTyping(): Promise<void> {}
	onMessage(): void {}
	onCallback(handler: (event: CallbackEvent) => void): void {
		this.callbackHandler = handler;
	}
	async answerCallback(id: string, text?: string): Promise<void> {
		this.callbackAnswers.push({ id, text });
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

function makeDeps(overrides: Partial<Parameters<typeof handleCallback>[1]> = {}) {
	const cfg = defaultGatewayConfig();
	cfg.telegram.allowedUsers = ["u1"];
	return {
		adapters: new Map<string, PlatformAdapter>(),
		cfg,
		pairing: createPairingStore(),
		bridge: {} as import("../src/gateway/router.ts").BridgeLike,
		adapter: new FakeAdapter(),
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

function findButtonByLabel(adapter: FakeAdapter, label: string): ButtonSpec | undefined {
	return adapter.sent[0]?.buttons?.flat().find((b) => b.label === label);
}

describe("button registry", () => {
	it("createPicker registers an entry and handleCallback selects an item", async () => {
		const adapter = new FakeAdapter();
		const selected: string[] = [];
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				title: "model",
				async resolve(item) {
					selected.push(item.value);
					return { done: true, text: `Selected ${item.label}` };
				},
			},
			{ replyTo: event.messageId },
		);
		expect(adapter.sent[0].text).toContain("model");
		expect(adapter.sent[0].buttons).toBeDefined();
		expect(activePickerIds()).toHaveLength(1);

		const target = findButtonByLabel(adapter, "B");
		expect(target).toBeDefined();
		await handleCallback(
			{
				id: "cb1",
				chatId: event.source.chatId,
				messageId: adapter.sent[0].messageId ?? "m1",
				userId: event.source.userId,
				data: target!.data,
			},
			makeDeps({ adapter }),
		);

		expect(adapter.callbackAnswers).toHaveLength(1);
		expect(selected).toEqual(["b"]);
		expect(activePickerIds()).toHaveLength(0);
		expect(adapter.edits[0].text).toContain("Selected B");
		expect(adapter.edits[0].buttons).toEqual([]);
	});

	it("handleCallback pages prev/next", async () => {
		const adapter = new FakeAdapter();
		const items: PickerItem[] = Array.from({ length: 10 }, (_, i) => ({ value: `i${i}`, label: `Item ${i}` }));
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items,
				title: "item",
				async resolve() {
					return { done: true, text: "done" };
				},
			},
			{ replyTo: event.messageId },
		);
		const messageId = adapter.sent[0].messageId ?? "m1";
		const nextButton = adapter.sent[0].buttons?.flat().find((b) => b.label === "Next ▶");
		expect(nextButton).toBeDefined();

		await handleCallback(
			{ id: "cb2", chatId: "chat1", messageId, userId: "u1", data: nextButton!.data },
			makeDeps({ adapter }),
		);
		expect(adapter.edits[0].text).toContain("(2/2)");
		const prevButton = adapter.edits[0].buttons?.flat().find((b) => b.label === "◀ Prev");
		expect(prevButton).toBeDefined();

		await handleCallback(
			{ id: "cb3", chatId: "chat1", messageId, userId: "u1", data: prevButton!.data },
			makeDeps({ adapter }),
		);
		expect(adapter.edits[1].text).toContain("(1/2)");
	});

	it("handleCallback transitions to a new picker state", async () => {
		const adapter = new FakeAdapter();
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [{ value: "provider", label: "Provider" }],
				title: "providers",
				async resolve(item) {
					if (item.value === "provider") {
						return {
							done: false,
							items: [{ value: "model", label: "Model" }],
							title: "Provider",
							breadcrumbs: "Provider",
						};
					}
					return { done: true, text: `Picked ${item.label}` };
				},
			},
			{ replyTo: event.messageId },
		);
		const messageId = adapter.sent[0].messageId ?? "m1";
		const providerButton = findButtonByLabel(adapter, "Provider");
		expect(providerButton).toBeDefined();

		await handleCallback(
			{ id: "cb1", chatId: "chat1", messageId, userId: "u1", data: providerButton!.data },
			makeDeps({ adapter }),
		);
		expect(activePickerIds()).toHaveLength(1);
		expect(adapter.edits[0].text).toContain("Provider");
		expect(adapter.edits[0].text).toContain("Provider"); // breadcrumbs
		const modelButton = adapter.edits[0].buttons?.flat().find((b) => b.label === "Model");
		expect(modelButton).toBeDefined();

		await handleCallback(
			{ id: "cb2", chatId: "chat1", messageId, userId: "u1", data: modelButton!.data },
			makeDeps({ adapter }),
		);
		expect(activePickerIds()).toHaveLength(0);
		expect(adapter.edits[1].text).toBe("Picked Model");
		expect(adapter.edits[1].buttons).toEqual([]);
	});

	it("rejects callbacks from a different user as unauthorized", async () => {
		const adapter = new FakeAdapter();
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [{ value: "a", label: "A" }],
				title: "model",
				async resolve() {
					return { done: true, text: "done" };
				},
			},
			{ replyTo: event.messageId },
		);
		const target = adapter.sent[0].buttons?.flat()[0];
		await handleCallback(
			{ id: "cb4", chatId: "chat1", messageId: adapter.sent[0].messageId ?? "m1", userId: "u2", data: target!.data },
			makeDeps({ adapter }),
		);
		expect(adapter.callbackAnswers[0].text).toBe("⛔ Not authorized.");
		expect(activePickerIds()).toHaveLength(1);
	});

	it("expired picker edits a timeout message and deletes the entry", async () => {
		vi.useFakeTimers();
		const adapter = new FakeAdapter();
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [{ value: "a", label: "A" }],
				title: "model",
				async resolve() {
					return { done: true, text: "done" };
				},
			},
			{ replyTo: event.messageId },
		);
		const messageId = adapter.sent[0].messageId ?? "m1";
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
		const target = adapter.sent[0].buttons?.flat()[0];
		await handleCallback(
			{ id: "cb5", chatId: "chat1", messageId, userId: "u1", data: target!.data },
			makeDeps({ adapter }),
		);
		expect(adapter.edits[0].text).toBe("⏱ Expired — run the command again.");
		expect(adapter.callbackAnswers[0].text).toBe("Picker expired — run the command again.");
		expect(activePickerIds()).toHaveLength(0);
		vi.useRealTimers();
	});

	it("TTL sweeper removes expired entries", () => {
		vi.useFakeTimers();
		startButtonSweeper();
		const adapter = new FakeAdapter();
		const event = makeEvent("/model");
		void createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [{ value: "a", label: "A" }],
				title: "model",
				async resolve() {
					return { done: true, text: "done" };
				},
			},
			{ replyTo: event.messageId },
		);
		void vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
		expect(activePickerIds()).toHaveLength(0);
		stopButtonSweeper();
		vi.useRealTimers();
	});

	it("two pickers in the same chat coexist", async () => {
		const adapter = new FakeAdapter();
		const event = makeEvent("/model");
		await createPicker(
			adapter,
			event.source,
			{
				kind: "model",
				sessionKey: "k1",
				invokerId: "u1",
				items: [{ value: "a", label: "A" }],
				title: "first",
				async resolve() {
					return { done: true, text: "first done" };
				},
			},
			{ replyTo: event.messageId },
		);
		await createPicker(
			adapter,
			event.source,
			{
				kind: "thinking",
				sessionKey: "k2",
				invokerId: "u1",
				items: [{ value: "b", label: "B" }],
				title: "second",
				async resolve() {
					return { done: true, text: "second done" };
				},
			},
			{ replyTo: event.messageId },
		);
		expect(activePickerIds()).toHaveLength(2);
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
		get model() {
			return model;
		},
		set model(value) {
			model = value;
		},
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
		setModel: vi.fn().mockImplementation((m: unknown) => {
			model = m as ReturnType<typeof fakeModel>;
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
	it("/model with no args renders a two-level picker that selects a model", async () => {
		const ctx = makeCommandCtx("/model");
		const cmd = CHAT_COMMANDS.find((c) => c.name === "model")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		expect(adapter.sent[0].text).toContain("Pick a model provider");
		const providerButton = adapter.sent[0].buttons?.flat().find((b) => b.label.includes("ollama-cloud"));
		expect(providerButton).toBeDefined();

		await handleCallback(
			{
				id: "cb1",
				chatId: ctx.event.source.chatId,
				messageId: adapter.sent[0].messageId ?? "m1",
				userId: ctx.event.source.userId,
				data: providerButton!.data,
			},
			makeDeps({ adapter }),
		);
		expect(adapter.edits[0].text).toContain("ollama-cloud");
		const modelButton = adapter.edits[0].buttons?.flat().find((b) => b.label === "qwen-2.5-72b");
		expect(modelButton).toBeDefined();

		await handleCallback(
			{
				id: "cb2",
				chatId: ctx.event.source.chatId,
				messageId: adapter.sent[0].messageId ?? "m1",
				userId: ctx.event.source.userId,
				data: modelButton!.data,
			},
			makeDeps({ adapter }),
		);
		expect(adapter.edits[1].text).toContain("☾ Model → ollama-cloud/qwen-2.5-72b");
		expect(adapter.edits[1].buttons).toEqual([]);
	});

	it("/model falls back to text list when sendButtons fails", async () => {
		const ctx = makeCommandCtx("/model");
		(ctx.adapter as FakeAdapter).failNextSend = true;
		const cmd = CHAT_COMMANDS.find((c) => c.name === "model")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		expect(adapter.sent[0].text).toContain("Pick a model provider");
		expect(adapter.sent[0].buttons).toBeDefined();
		expect(adapter.sent[1].text).toContain("Current:");
		expect(adapter.sent[1].text).toContain("1)");
	});

	it("/model with args still uses the direct text path", async () => {
		const ctx = makeCommandCtx("/model qwen");
		const cmd = CHAT_COMMANDS.find((c) => c.name === "model")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		expect(adapter.sent[0].buttons).toBeUndefined();
		expect(adapter.sent[0].text).toContain("Model →");
	});

	it("/thinking with no args renders a picker", async () => {
		const session = createFakeSession();
		session.model = fakeModel("claude-opus-4", "anthropic", true);
		const ctx = makeCommandCtx("/thinking");
		ctx.bridge = {
			getStatus: () => ({ busy: false, queueDepth: 0 }),
			getSession: vi.fn().mockResolvedValue(session),
		} as unknown as import("../src/gateway/router.ts").BridgeLike;

		const cmd = CHAT_COMMANDS.find((c) => c.name === "thinking")!;
		await runChatCommand(cmd, ctx);
		const adapter = ctx.adapter as FakeAdapter;
		expect(adapter.sent[0].text).toContain("Pick a thinking level");
		const levelButton = findButtonByLabel(adapter, "high");
		expect(levelButton).toBeDefined();

		await handleCallback(
			{
				id: "cb3",
				chatId: ctx.event.source.chatId,
				messageId: adapter.sent[0].messageId ?? "m1",
				userId: ctx.event.source.userId,
				data: levelButton!.data,
			},
			makeDeps({ adapter }),
		);
		expect(adapter.edits[0].text).toBe("☾ Thinking → high");
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
		const buttons: ButtonSpec[][] = [[{ label: "One", data: "b1" }]];
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
		const buttons: ButtonSpec[][] = [[{ label: "Two", data: "b2" }]];
		await adapter.editMessage("1", "7", "updated", buttons);
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
		await adapter.answerCallback("cq1", "hello");
		expect(callApi).toHaveBeenCalledWith("answerCallbackQuery", { callback_query_id: "cq1", text: "hello" });
	});

	it("callbackQueryToEvent maps a query to a CallbackEvent", () => {
		const event = callbackQueryToEvent(makeQuery("b1"));
		expect(event).not.toBeNull();
		expect(event?.id).toBe("cq1");
		expect(event?.data).toBe("b1");
		expect(event?.messageId).toBe("7");
		expect(event?.userId).toBe("101");
	});
});

// ---------------------------------------------------------------------------
// Discord adapter
// ---------------------------------------------------------------------------

type Listener = (arg: unknown) => void;

class MockClient implements DiscordClientLike {
	user: { id: string } | null = null;
	loginTokens: string[] = [];
	destroyed = false;
	channelMap: Map<string, DiscordChannelLike> = new Map();
	private listeners: Map<string, Listener[]> = new Map();

	async login(token: string): Promise<unknown> {
		this.loginTokens.push(token);
		return "ok";
	}

	on(event: string, listener: Listener): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		return this;
	}

	once(event: string, listener: () => void): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener as Listener);
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
			reply: vi.fn().mockResolvedValue(undefined),
		};
	}

	it("sendButtons builds Discord action rows", async () => {
		const client = new MockClient();
		const { channel, sent } = fakeChannel("555");
		client.channelMap.set("555", channel);
		const adapter = await connectAdapter(client);
		const buttons: ButtonSpec[][] = [
			[
				{ label: "A", data: "a" },
				{ label: "B", data: "b" },
			],
			[{ label: "C", data: "c" }],
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
		expect(events[0].data).toBe("picker:x:select:0");
		expect(events[0].id).toBe("int-picker:x:select:0");
		await adapter.disconnect();
	});

	it("answerCallback defers the stored interaction", async () => {
		const client = new MockClient();
		const adapter = await connectAdapter(client);
		adapter.onCallback(() => {});
		const interaction = makeButtonInteraction("picker:x:select:0");
		client.emit(Events.InteractionCreate, interaction);
		await adapter.answerCallback("int-picker:x:select:0");
		expect(interaction.deferUpdate).toHaveBeenCalled();
		await adapter.disconnect();
	});

	it("answerCallback with text replies ephemerally", async () => {
		const client = new MockClient();
		const adapter = await connectAdapter(client);
		adapter.onCallback(() => {});
		const interaction = makeButtonInteraction("picker:x:select:0");
		client.emit(Events.InteractionCreate, interaction);
		await adapter.answerCallback("int-picker:x:select:0", "Not authorized");
		expect(interaction.reply).toHaveBeenCalledWith({ content: "Not authorized", ephemeral: true });
		await adapter.disconnect();
	});

	it("buttonInteractionToEvent maps channel type and user", () => {
		const event = buttonInteractionToEvent(makeButtonInteraction("btn"));
		expect(event).not.toBeNull();
		expect(event?.chatId).toBe("555");
		expect(event?.userId).toBe("42");
		expect(event?.data).toBe("btn");
	});
});
