import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	BlockUnitCounter,
	computeSmoothRevealStep,
	countGraphemesBeforeToolCall,
	countMessageGraphemes,
	sliceMessageContent,
	SMOOTH_STREAMING_MAX_GRAPHEMES_PER_TICK,
} from "../src/modes/interactive/smooth-streaming.ts";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function thinkingOf(message: AssistantMessage): string {
	return message.content
		.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
		.map((b) => b.thinking)
		.join("");
}

function toolIds(message: AssistantMessage): string[] {
	return message.content.filter((b) => b.type === "toolCall").map((b) => b.id);
}

describe("BlockUnitCounter", () => {
	test("counts plain ASCII graphemes", () => {
		const counter = new BlockUnitCounter();
		counter.update("hello");
		expect(counter.count).toBe(5);
		expect(counter.slice(3)).toBe("hel");
	});

	test("treats ZWJ emoji sequences as single graphemes", () => {
		const counter = new BlockUnitCounter();
		// Family emoji is one extended grapheme cluster.
		const family = "👨‍👩‍👧‍👦";
		counter.update(family);
		expect(counter.count).toBe(1);
		expect(counter.slice(1)).toBe(family);
		counter.update(`${family}!`);
		expect(counter.count).toBe(2);
		expect(counter.slice(1)).toBe(family);
		expect(counter.slice(2)).toBe(`${family}!`);
	});

	test("incrementally accepts append-only mutations without full dump", () => {
		const counter = new BlockUnitCounter();
		counter.update("ab");
		expect(counter.count).toBe(2);
		counter.update("abcd");
		expect(counter.count).toBe(4);
		expect(counter.slice(3)).toBe("abc");
	});
});

describe("countMessageGraphemes / sliceMessageContent", () => {
	test("append-mutated same message object still slices incrementally (no WeakMap stale full dump)", () => {
		// Providers mutate block.text += delta on the SAME content object.
		const textBlock = { type: "text" as const, text: "Hi" };
		const message = createAssistantMessage([textBlock]);

		expect(countMessageGraphemes(message)).toBe(2);
		expect(textOf(sliceMessageContent(message, 1))).toBe("H");

		// In-place append on the same block identity (the production bug path).
		textBlock.text += " there";
		expect(countMessageGraphemes(message)).toBe(8);
		// Must NOT return the full remaining text after a small max.
		expect(textOf(sliceMessageContent(message, 3))).toBe("Hi ");
		expect(textOf(sliceMessageContent(message, 8))).toBe("Hi there");

		textBlock.text += "!";
		expect(countMessageGraphemes(message)).toBe(9);
		expect(textOf(sliceMessageContent(message, 4))).toBe("Hi t");
		// Slice never jumps to the full string when max < total.
		const partial = textOf(sliceMessageContent(message, 5));
		expect(partial).toBe("Hi th");
		expect(partial).not.toBe(textBlock.text);
	});

	test("slice never returns full remaining text after a delta append", () => {
		const textBlock = { type: "text" as const, text: "abc" };
		const message = createAssistantMessage([textBlock]);
		// Prime the per-block cache.
		expect(countMessageGraphemes(message)).toBe(3);
		textBlock.text += "defghij";
		const sliced = sliceMessageContent(message, 4);
		expect(textOf(sliced)).toBe("abcd");
		expect(textOf(sliced).length).toBeLessThan(textBlock.text.length);
	});

	test("hidden thinking is excluded from budget and output", () => {
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "secret-plan" },
			{ type: "text", text: "hello" },
		]);
		expect(countMessageGraphemes(message)).toBe("secret-plan".length + "hello".length);
		expect(countMessageGraphemes(message, { hideThinking: true })).toBe("hello".length);

		const hidden = sliceMessageContent(message, 3, { hideThinking: true });
		expect(thinkingOf(hidden)).toBe("");
		expect(textOf(hidden)).toBe("hel");

		const visible = sliceMessageContent(message, 3, { hideThinking: false });
		expect(thinkingOf(visible)).toBe("sec");
		expect(textOf(visible)).toBe("");
	});

	test("maxGraphemes <= 0 keeps leading tool calls and drops text/thinking", () => {
		const leadingTools = createAssistantMessage([
			{ type: "toolCall", id: "t0", name: "read", arguments: { path: "a.ts" } },
			{ type: "text", text: "hello" },
		]);
		const leading = sliceMessageContent(leadingTools, 0);
		expect(toolIds(leading)).toEqual(["t0"]);
		expect(textOf(leading)).toBe("");

		// Tools after unrevealed text must stay hidden at 0.
		const trailingTools = createAssistantMessage([
			{ type: "thinking", thinking: "nope" },
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
		]);
		const trailing = sliceMessageContent(trailingTools, 0);
		expect(trailing.content).toHaveLength(0);
		expect(toolIds(trailing)).toEqual([]);
	});

	test("toolCall is a reveal boundary after leading text", () => {
		const message = createAssistantMessage([
			{ type: "text", text: "ab" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			{ type: "text", text: "cd" },
		]);
		// Partial leading text: tool must not appear yet.
		expect(toolIds(sliceMessageContent(message, 1))).toEqual([]);
		expect(textOf(sliceMessageContent(message, 1))).toBe("a");
		// Fully revealed leading text: tool appears; trailing text still gated.
		const mid = sliceMessageContent(message, 2);
		expect(toolIds(mid)).toEqual(["t1"]);
		expect(textOf(mid)).toBe("ab");
		// Budget past the tool continues into trailing text.
		const fullish = sliceMessageContent(message, 3);
		expect(toolIds(fullish)).toEqual(["t1"]);
		expect(textOf(fullish)).toBe("abc");
		expect(countGraphemesBeforeToolCall(message, "t1")).toBe(2);
	});
});

describe("computeSmoothRevealStep", () => {
	test("uses base speed for small backlog and caps large catch-up", () => {
		expect(computeSmoothRevealStep(0)).toBe(0);
		expect(computeSmoothRevealStep(1)).toBe(4);
		expect(computeSmoothRevealStep(8)).toBe(4);
		expect(computeSmoothRevealStep(80)).toBe(10);
		expect(computeSmoothRevealStep(10_000)).toBe(SMOOTH_STREAMING_MAX_GRAPHEMES_PER_TICK);
	});
});

describe("SettingsManager smoothStreaming", () => {
	test("defaults off and round-trips get/set", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getSmoothStreaming()).toBe(false);
		manager.setSmoothStreaming(true);
		expect(manager.getSmoothStreaming()).toBe(true);
		manager.setSmoothStreaming(false);
		expect(manager.getSmoothStreaming()).toBe(false);
	});
});
