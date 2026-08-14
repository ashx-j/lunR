import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface CacheControl {
	type: string;
	ttl?: string;
}

interface ContentBlock {
	type: string;
	text?: string;
	cache_control?: CacheControl;
}

interface CapturedPayload {
	system?: Array<{ type: string; text: string; cache_control?: CacheControl }>;
	messages: Array<{
		role: string;
		content: string | ContentBlock[];
	}>;
	tools?: Array<{ name: string; cache_control?: CacheControl }>;
}

function countCacheControls(payload: CapturedPayload): number {
	let count = 0;
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Object.hasOwn(value, "cache_control") && (value as { cache_control?: unknown }).cache_control) {
			count++;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(payload);
	return count;
}

function lastCacheableBlock(content: string | ContentBlock[]): ContentBlock | undefined {
	if (!Array.isArray(content) || content.length === 0) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (
			block.type === "text" ||
			block.type === "tool_use" ||
			block.type === "tool_result" ||
			block.type === "image"
		) {
			return block;
		}
	}
	return undefined;
}

function makeTool(): Tool {
	return {
		name: "read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
	};
}

function makeUser(content: string, timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function makeAssistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I'll read that." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "foo.ts" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 3,
	};
}

function toolLoopContext(): Context {
	return {
		systemPrompt: "You are a helpful coding assistant.",
		messages: [makeUser("Read foo.ts", 1), makeAssistantToolCall(), makeToolResult()],
		tools: [makeTool()],
	};
}

async function capturePayload(apiKey: string): Promise<CapturedPayload> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	let captured: CapturedPayload | undefined;
	try {
		const s = streamAnthropic(model, toolLoopContext(), {
			apiKey,
			onPayload: (payload) => {
				captured = payload as CapturedPayload;
				throw new PayloadCaptured();
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}
	} catch (error) {
		if (!(error instanceof PayloadCaptured)) {
			// Expected: fake key / captured throw. Other errors still leave payload.
		}
	}
	if (!captured) {
		throw new Error("Expected Anthropic payload to be captured");
	}
	return captured;
}

describe("Anthropic cache breakpoints (dual-mark tail)", () => {
	it("marks last user + last assistant and stays within 4 breakpoints on the API-key path", async () => {
		const payload = await capturePayload("sk-ant-api03-fake");

		expect(payload.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(payload.tools?.[payload.tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });

		const lastUser = [...payload.messages].reverse().find((message) => message.role === "user");
		const lastAssistant = [...payload.messages].reverse().find((message) => message.role === "assistant");
		expect(lastCacheableBlock(lastUser?.content ?? [])?.cache_control).toEqual({ type: "ephemeral" });
		expect(lastCacheableBlock(lastAssistant?.content ?? [])?.cache_control).toEqual({ type: "ephemeral" });

		expect(countCacheControls(payload)).toBeLessThanOrEqual(4);
	});

	it("drops the OAuth preamble breakpoint so dual-mark still fits in 4 slots", async () => {
		const payload = await capturePayload("sk-ant-oat01-fake");

		expect(payload.system?.length).toBeGreaterThanOrEqual(2);
		expect(payload.system?.[0]?.text).toContain("You are Claude Code");
		expect(payload.system?.[0]?.cache_control).toBeUndefined();
		expect(payload.system?.[1]?.cache_control).toEqual({ type: "ephemeral" });
		expect(payload.tools?.[payload.tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });

		const lastUser = [...payload.messages].reverse().find((message) => message.role === "user");
		const lastAssistant = [...payload.messages].reverse().find((message) => message.role === "assistant");
		expect(lastCacheableBlock(lastUser?.content ?? [])?.cache_control).toEqual({ type: "ephemeral" });
		expect(lastCacheableBlock(lastAssistant?.content ?? [])?.cache_control).toEqual({ type: "ephemeral" });

		expect(countCacheControls(payload)).toBe(4);
	});
});
