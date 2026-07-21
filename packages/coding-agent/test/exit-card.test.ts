import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { buildExitCard, computeExitCardStats } from "../src/modes/interactive/components/exit-card.ts";

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function msgEntry(message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id: `e-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as SessionEntry;
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(
	blocks: AssistantMessage["content"],
	usage: Usage = createMockUsage(100, 50),
): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
	return {
		type: "toolCall",
		id: "tc-1",
		name,
		arguments: args,
	} as AssistantMessage["content"][number];
}

describe("computeExitCardStats", () => {
	it("should return zero turns for an empty session", () => {
		const stats = computeExitCardStats([]);
		expect(stats.turns).toBe(0);
		expect(stats.tokens).toBe(0);
		expect(stats.filesChanged).toBe(0);
	});

	it("should count user messages as turns", () => {
		const entries: SessionEntry[] = [
			msgEntry(createUserMessage("hello")),
			msgEntry(createAssistantMessage([{ type: "text", text: "hi" }])),
			msgEntry(createUserMessage("again")),
		];
		const stats = computeExitCardStats(entries);
		expect(stats.turns).toBe(2);
	});

	it("should sum input + cacheRead + cacheWrite + output across assistant messages", () => {
		const entries: SessionEntry[] = [
			msgEntry(createUserMessage("hello")),
			msgEntry(createAssistantMessage([{ type: "text", text: "hi" }], createMockUsage(1000, 500, 200, 50))),
			msgEntry(createAssistantMessage([{ type: "text", text: "more" }], createMockUsage(300, 100))),
		];
		const stats = computeExitCardStats(entries);
		// 1000+500+200+50 + 300+100 = 2150
		expect(stats.tokens).toBe(2150);
	});

	it("should count modified files (write + edit, deduped)", () => {
		const entries: SessionEntry[] = [
			msgEntry(createUserMessage("do work")),
			msgEntry(
				createAssistantMessage([
					{ type: "text", text: "editing" },
					toolCall("write", { path: "/a.ts" }),
					toolCall("edit", { path: "/b.ts" }),
					toolCall("edit", { path: "/a.ts" }),
					toolCall("read", { path: "/c.ts" }),
				]),
			),
		];
		const stats = computeExitCardStats(entries);
		// a.ts (write + edit dedup), b.ts (edit) = 2 modified; c.ts is read-only
		expect(stats.filesChanged).toBe(2);
	});

	it("should ignore read-only files", () => {
		const entries: SessionEntry[] = [
			msgEntry(createUserMessage("look")),
			msgEntry(createAssistantMessage([{ type: "text", text: "reading" }, toolCall("read", { path: "/x.ts" })])),
		];
		const stats = computeExitCardStats(entries);
		expect(stats.filesChanged).toBe(0);
	});
});

describe("buildExitCard", () => {
	it("should return no lines for an empty session (0 turns)", () => {
		expect(buildExitCard({ turns: 0, tokens: 0, filesChanged: 0 })).toEqual([]);
	});

	it("should render a 4-line bordered box for a non-empty session", () => {
		const lines = buildExitCard({ turns: 7, tokens: 48200, filesChanged: 3 });
		expect(lines.length).toBe(4);
		expect(lines[0]?.startsWith("╭")).toBe(true);
		expect(lines[3]?.endsWith("╯")).toBe(true);
		// turn count and compact token format appear on line 2
		expect(lines[1]).toContain("7 turns");
		expect(lines[1]).toContain("48k tok");
		// files changed on line 3
		expect(lines[2]).toContain("3 files changed");
	});

	it("should singularize '1 turn' and '1 file'", () => {
		const lines = buildExitCard({ turns: 1, tokens: 500, filesChanged: 1 });
		expect(lines[1]).toContain("1 turn");
		expect(lines[2]).toContain("1 file changed");
	});
});
