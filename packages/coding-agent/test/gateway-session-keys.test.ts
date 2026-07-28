import { describe, expect, it } from "vitest";
import { buildSessionKey } from "../src/gateway/session-keys.ts";
import type { SessionSource } from "../src/gateway/types.ts";

function source(overrides: Partial<SessionSource> = {}): SessionSource {
	return {
		platform: "telegram",
		chatId: "12345",
		chatType: "dm",
		userId: "u1",
		...overrides,
	};
}

describe("buildSessionKey", () => {
	it("dm: platform + chatType + chatId, no userId", () => {
		expect(buildSessionKey(source(), { groupSessionsPerUser: true })).toBe("agent:main:telegram:dm:12345");
	});

	it("group with per-user on: appends userId", () => {
		expect(buildSessionKey(source({ chatType: "group" }), { groupSessionsPerUser: true })).toBe(
			"agent:main:telegram:group:12345:u1",
		);
	});

	it("group with per-user off: no userId", () => {
		expect(buildSessionKey(source({ chatType: "group" }), { groupSessionsPerUser: false })).toBe(
			"agent:main:telegram:group:12345",
		);
	});

	it("channel behaves like group", () => {
		expect(buildSessionKey(source({ chatType: "channel" }), { groupSessionsPerUser: true })).toBe(
			"agent:main:telegram:channel:12345:u1",
		);
	});

	it("thread: appends threadId, never userId (thread sessions are shared)", () => {
		expect(buildSessionKey(source({ chatType: "group", threadId: "t9" }), { groupSessionsPerUser: true })).toBe(
			"agent:main:telegram:group:12345:t9",
		);
		expect(buildSessionKey(source({ chatType: "thread", threadId: "t9" }), { groupSessionsPerUser: true })).toBe(
			"agent:main:telegram:thread:12345:t9",
		);
	});

	it("dm ignores groupSessionsPerUser", () => {
		expect(buildSessionKey(source(), { groupSessionsPerUser: false })).toBe("agent:main:telegram:dm:12345");
	});

	it("sanitizes colons and whitespace in every component", () => {
		expect(
			buildSessionKey(source({ chatId: "chat:42 x", userId: "u 1:2", chatType: "group" }), {
				groupSessionsPerUser: true,
			}),
		).toBe("agent:main:telegram:group:chat_42_x:u_1_2");
	});
});
