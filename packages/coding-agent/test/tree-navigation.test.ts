import { describe, expect, it } from "vitest";
import { getUserMessagesForForking, type TreeNavigationHost } from "../src/core/tree-navigation.ts";

describe("getUserMessagesForForking", () => {
	it("lists the branch's user messages with their text parts joined and skips image-only ones", () => {
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: "first" } },
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
			{
				type: "message",
				id: "u2",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "look at " },
						{ type: "image", data: "aGk=", mimeType: "image/png" },
						{ type: "text", text: "this" },
					],
				},
			},
			{
				type: "message",
				id: "u3",
				message: { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
			},
			{ type: "custom_message", id: "c1", content: "not a user message" },
		];
		const host = { sessionManager: { getBranch: () => branch } } as unknown as TreeNavigationHost;
		expect(getUserMessagesForForking(host)).toEqual([
			{ entryId: "u1", text: "first" },
			{ entryId: "u2", text: "look at this" },
		]);
	});
});
