import {
	type AssistantMessage,
	CLAUDE_CODE_HISTORY_REPLAYED,
	CLAUDE_CODE_HISTORY_REPLAYED_NOTE,
} from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { type ChatHistoryHost, maybeShowHistoryReplayNotice } from "../src/modes/interactive/chat-history.ts";

function reply(replayed: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...(replayed ? { diagnostics: [{ type: CLAUDE_CODE_HISTORY_REPLAYED, timestamp: 0 }] } : {}),
	};
}

describe("InteractiveMode history replay notice", () => {
	test("warns each time a session crosses into the uncached replay, not on every reply after", () => {
		const entries: { type: "message"; message: AssistantMessage }[] = [];
		const fakeThis = { sessionManager: { getEntries: () => entries }, showWarning: vi.fn() };
		// Each reply is checked before it is persisted, like message_end.
		for (const replayed of [false, true, true, false, true]) {
			const message = reply(replayed);
			maybeShowHistoryReplayNotice(fakeThis as unknown as ChatHistoryHost, message);
			entries.push({ type: "message", message });
		}

		// Once on crossing, once again after a /compact brought it back under the limit and it crossed again.
		expect(fakeThis.showWarning.mock.calls).toEqual([
			[CLAUDE_CODE_HISTORY_REPLAYED_NOTE],
			[CLAUDE_CODE_HISTORY_REPLAYED_NOTE],
		]);
	});
});
