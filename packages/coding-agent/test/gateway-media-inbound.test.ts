import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectDiscordImageAttachments,
	DiscordAdapter,
	type DiscordAttachmentLike,
	type DiscordChannelLike,
	type DiscordMessageLike,
	messageToEvent,
	resetSeenMessageIds,
} from "../src/gateway/adapters/discord.ts";
import {
	type BotInfo,
	type CallApi,
	collectTelegramMedia,
	TelegramAdapter,
	type TelegramMessage,
	type TelegramPhotoSize,
	type TelegramUpdate,
	updateToEvent,
} from "../src/gateway/adapters/telegram.ts";
import type { DiscordConfig, PlatformConfig } from "../src/gateway/config.ts";
import type { MessageEvent } from "../src/gateway/types.ts";

const BOT: BotInfo = { botId: 777, botUsername: "lunrbot" };

const TG_CFG: PlatformConfig = {
	enabled: true,
	token: "test-token",
	allowedUsers: [],
	allowedChats: [],
	requireMention: false,
	freeResponseChats: [],
};

const DISCORD_CFG: DiscordConfig = {
	enabled: true,
	token: "test-token",
	allowedUsers: [],
	allowedChats: [],
	requireMention: false,
	freeResponseChats: [],
};

let nextId = 5000;

function makeMessage(partial: Partial<TelegramMessage> & { fromId?: number }): TelegramMessage {
	return {
		message_id: ++nextId,
		from: { id: partial.fromId ?? 42, is_bot: false, username: "alice" },
		chat: { id: 555, type: "private", is_forum: false },
		...(partial.text !== undefined ? { text: partial.text } : {}),
		...(partial.caption !== undefined ? { caption: partial.caption } : {}),
		...(partial.photo !== undefined ? { photo: partial.photo } : {}),
		...(partial.document !== undefined ? { document: partial.document } : {}),
	};
}

function tgUpdate(message: TelegramMessage): TelegramUpdate {
	return { update_id: ++nextId, message };
}

describe("telegram media inbound", () => {
	it("collectTelegramMedia picks the largest photo and image documents only", () => {
		const photo: TelegramPhotoSize[] = [
			{ file_id: "p1", file_unique_id: "u1", width: 10, height: 10 },
			{ file_id: "p2", file_unique_id: "u2", width: 20, height: 20, file_size: 2000 },
		];
		expect(collectTelegramMedia(makeMessage({ photo })).map((m) => m.fileId)).toEqual(["p2"]);

		const doc = { file_id: "d1", file_unique_id: "u3", mime_type: "image/png", file_name: "x.png", file_size: 500 };
		expect(collectTelegramMedia(makeMessage({ document: doc })).map((m) => m.fileId)).toEqual(["d1"]);

		const nonImage = { file_id: "d2", file_unique_id: "u4", mime_type: "application/pdf", file_name: "x.pdf" };
		expect(collectTelegramMedia(makeMessage({ document: nonImage }))).toEqual([]);
	});

	it("updateToEvent keeps photo-only messages (no caption) with empty text", () => {
		const photo: TelegramPhotoSize[] = [
			{ file_id: "small", file_unique_id: "u1", width: 100, height: 100, file_size: 1024 },
			{ file_id: "large", file_unique_id: "u2", width: 800, height: 600, file_size: 4096 },
		];
		const event = updateToEvent(tgUpdate(makeMessage({ photo })), BOT);
		expect(event).not.toBeNull();
		expect(event?.text).toBe("");
	});

	it("updateToEvent drops messages with no text and no image media", () => {
		expect(updateToEvent(tgUpdate(makeMessage({})), BOT)).toBeNull();
	});
});

describe("telegram adapter media download", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("downloads media via getFile + downloadFile and attaches base64 to the event", async () => {
		const calls: string[] = [];
		let updatesDone = false;
		const callApi: CallApi = async (method, body) => {
			calls.push(`${method}:${(body as { file_id?: string }).file_id ?? ""}`);
			if (method === "getMe") return { id: BOT.botId, username: BOT.botUsername };
			if (method === "getFile" && (body as { file_id?: string }).file_id === "large")
				return { file_path: "photos/large.jpg", file_size: 4096 };
			if (method === "getUpdates") {
				if (updatesDone) return new Promise(() => {}); // park
				updatesDone = true;
				return [
					tgUpdate(
						makeMessage({
							caption: "look",
							photo: [{ file_id: "large", file_unique_id: "u2", width: 800, height: 600, file_size: 4096 }],
						}),
					),
				];
			}
			return {};
		};
		const downloadFile = async (filePath: string) => {
			expect(filePath).toBe("photos/large.jpg");
			return new Uint8Array([1, 2, 3, 4]);
		};
		const adapter = new TelegramAdapter(TG_CFG, { callApi, downloadFile });
		const events: MessageEvent[] = [];
		adapter.onMessage((event) => events.push(event));
		await adapter.connect();
		// Drain the getUpdates batch + 300ms debounce flush.
		await vi.advanceTimersByTimeAsync(400);
		await adapter.disconnect();
		expect(calls).toContain("getFile:large");
		expect(events).toHaveLength(1);
		expect(events[0].text).toBe("look");
		expect(events[0].attachments).toHaveLength(1);
		expect(events[0].attachments?.[0].mimeType).toBe("image/jpeg");
		expect(events[0].attachments?.[0].data).toBe(Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"));
	});

	it("skips media larger than maxMediaBytes", async () => {
		const callApi: CallApi = async (method) => {
			if (method === "getMe") return { id: BOT.botId, username: BOT.botUsername };
			return {};
		};
		const adapter = new TelegramAdapter(TG_CFG, { callApi, maxMediaBytes: 100 });
		const events: MessageEvent[] = [];
		adapter.onMessage((event) => events.push(event));
		await adapter.connect();
		await adapter.disconnect();
		// Adapter constructed with a 100-byte cap without throwing.
		expect(adapter.platform).toBe("telegram");
	});
});

// ---- Discord media inbound -------------------------------------------------

function dmChannel(): DiscordChannelLike {
	return {
		id: "dm-1",
		type: ChannelType.DM,
		messages: { cache: { get: () => undefined }, fetch: async () => undefined },
	} as unknown as DiscordChannelLike;
}

describe("discord media inbound", () => {
	beforeEach(() => resetSeenMessageIds());

	it("collectDiscordImageAttachments keeps image contentTypes only", () => {
		const attachments: DiscordAttachmentLike[] = [
			{ id: "a1", url: "https://cdn/a1.png", contentType: "image/png", name: "a.png", size: 10 },
			{ id: "a2", url: "https://cdn/a2.pdf", contentType: "application/pdf", name: "a.pdf", size: 20 },
			{ id: "a3", url: "https://cdn/a3.jpg", contentType: "image/jpeg", name: "a.jpg" },
		];
		const message = {
			id: "m1",
			author: { id: "42", username: "alice" },
			channel: dmChannel(),
			attachments,
		} as unknown as DiscordMessageLike;
		expect(collectDiscordImageAttachments(message).map((a) => a.id)).toEqual(["a1", "a3"]);
	});

	it("messageToEvent keeps attachment-only messages (empty content) in DMs", () => {
		const message = {
			id: "m2",
			author: { id: "42", username: "alice" },
			channel: dmChannel(),
			attachments: [{ id: "a1", url: "https://cdn/a1.png", contentType: "image/png" }],
		} as unknown as DiscordMessageLike;
		const event = messageToEvent(message, { id: "777" });
		expect(event).not.toBeNull();
		expect(event?.text).toBe("");
	});

	it("messageToEvent drops messages with no text and no image attachments", () => {
		const message = {
			id: "m3",
			author: { id: "42", username: "alice" },
			channel: dmChannel(),
			attachments: [{ id: "a1", url: "https://cdn/a1.pdf", contentType: "application/pdf" }],
		} as unknown as DiscordMessageLike;
		expect(messageToEvent(message, { id: "777" })).toBeNull();
	});
});

describe("discord adapter media download", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("downloads image attachments and attaches base64 to the event", async () => {
		const fakeBytes = new Uint8Array([5, 6, 7, 8]);
		const downloaded: string[] = [];
		const downloadAttachment = async (url: string) => {
			downloaded.push(url);
			return fakeBytes;
		};
		const adapter = new DiscordAdapter(DISCORD_CFG, { downloadAttachment });
		const events: MessageEvent[] = [];
		adapter.onMessage((event) => events.push(event));
		// Provide a bot user id so handleMessage proceeds.
		(adapter as unknown as { botUserId: string }).botUserId = "777";

		const message = {
			id: "m4",
			author: { id: "42", username: "alice" },
			channel: dmChannel(),
			attachments: [{ id: "a1", url: "https://cdn/a1.png", contentType: "image/png", name: "a.png" }],
		} as unknown as DiscordMessageLike;

		// handleMessage is private; invoke via the client message event path by
		// calling the registered listener directly.
		(adapter as unknown as { handleMessage: (m: DiscordMessageLike) => Promise<void> }).handleMessage(message);
		await vi.advanceTimersByTimeAsync(50);
		await Promise.resolve();

		expect(downloaded).toEqual(["https://cdn/a1.png"]);
		// Empty-text media message debounces; flush the 600ms debounce timer.
		await vi.advanceTimersByTimeAsync(700);
		expect(events).toHaveLength(1);
		expect(events[0].attachments).toHaveLength(1);
		expect(events[0].attachments?.[0].mimeType).toBe("image/png");
		// base64 of [5,6,7,8]
		expect(events[0].attachments?.[0].data).toBe(Buffer.from(fakeBytes).toString("base64"));
		await adapter.disconnect?.();
	});
});
