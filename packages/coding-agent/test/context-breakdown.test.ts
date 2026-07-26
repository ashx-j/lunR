import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { estimateContextTokens, estimateTokens } from "../src/core/compaction/index.ts";
import { computeContextBreakdown, estimateToolDefinitionTokens } from "../src/core/context-breakdown.ts";
import { renderContextBox } from "../src/modes/interactive/components/context-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("default", false);

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

const TOOLS = [
	{
		name: "read",
		description: "Read a file from disk",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "bash",
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
];

describe("estimateToolDefinitionTokens", () => {
	it("estimates name + description + schema at chars/4", () => {
		const expectedChars =
			TOOLS[0].name.length +
			TOOLS[0].description.length +
			JSON.stringify(TOOLS[0].parameters).length +
			TOOLS[1].name.length +
			TOOLS[1].description.length +
			JSON.stringify(TOOLS[1].parameters).length;
		expect(estimateToolDefinitionTokens(TOOLS)).toBe(Math.ceil(expectedChars / 4));
	});

	it("returns 0 for no tools", () => {
		expect(estimateToolDefinitionTokens([])).toBe(0);
	});
});

describe("computeContextBreakdown", () => {
	it("splits messages into categories and sums to total", () => {
		const messages: AgentMessage[] = [
			createUserMessage("hello world, this is a user message"),
			createAssistantMessage([
				{ type: "thinking", thinking: "let me think about this carefully" },
				{ type: "text", text: "here is my answer" },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a.txt" } },
			]),
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "file contents here" }],
				isError: false,
				timestamp: Date.now(),
			} as AgentMessage,
		];

		const breakdown = computeContextBreakdown({
			systemPrompt: "x".repeat(400),
			tools: TOOLS,
			messages,
			contextWindow: 200_000,
		});

		expect(breakdown.systemPrompt).toBe(100);
		expect(breakdown.user).toBe(estimateTokens(messages[0]));
		expect(breakdown.assistantText).toBe(Math.ceil("here is my answer".length / 4));
		expect(breakdown.thinking).toBe(Math.ceil("let me think about this carefully".length / 4));
		expect(breakdown.toolCalls).toBeGreaterThan(0);
		expect(breakdown.toolResults).toBe(estimateTokens(messages[2]));
		expect(breakdown.summaries).toBe(0);

		const sum =
			breakdown.systemPrompt +
			breakdown.toolDefinitions +
			breakdown.user +
			breakdown.assistantText +
			breakdown.thinking +
			breakdown.toolCalls +
			breakdown.toolResults +
			breakdown.summaries;
		expect(breakdown.total).toBe(sum);
		expect(breakdown.free).toBe(200_000 - breakdown.total);
	});

	it("message categories stay within rounding of estimateTokens", () => {
		const messages: AgentMessage[] = [
			createUserMessage("a".repeat(1000)),
			createAssistantMessage([
				{ type: "thinking", thinking: "b".repeat(500) },
				{ type: "text", text: "c".repeat(700) },
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "d".repeat(300) } },
			]),
			createAssistantMessage([{ type: "text", text: "e".repeat(100) }]),
		];

		const breakdown = computeContextBreakdown({
			systemPrompt: "",
			tools: [],
			messages,
			contextWindow: 200_000,
		});

		const perMessage = messages.reduce((acc, m) => acc + estimateTokens(m), 0);
		const messagePart =
			breakdown.user +
			breakdown.assistantText +
			breakdown.thinking +
			breakdown.toolCalls +
			breakdown.toolResults +
			breakdown.summaries;
		// Per-category ceil vs per-message ceil: at most 2 tokens slack per assistant message.
		expect(Math.abs(messagePart - perMessage)).toBeLessThanOrEqual(4);
	});

	it("counts compaction summaries as summaries", () => {
		const summary = "f".repeat(400);
		const breakdown = computeContextBreakdown({
			systemPrompt: "",
			tools: [],
			messages: [{ role: "compactionSummary", summary, timestamp: Date.now() } as unknown as AgentMessage],
			contextWindow: 200_000,
		});
		expect(breakdown.summaries).toBe(100);
		expect(breakdown.user).toBe(0);
	});

	it("clamps free at zero when over the window", () => {
		const breakdown = computeContextBreakdown({
			systemPrompt: "x".repeat(4000),
			tools: [],
			messages: [],
			contextWindow: 100,
		});
		expect(breakdown.total).toBe(1000);
		expect(breakdown.free).toBe(0);
	});
});

describe("renderContextBox", () => {
	it("renders all categories, total, and the estimates note", () => {
		const messages: AgentMessage[] = [
			createUserMessage("hello there"),
			createAssistantMessage([
				{ type: "thinking", thinking: "thinking words" },
				{ type: "text", text: "answer text" },
			]),
		];
		const breakdown = computeContextBreakdown({
			systemPrompt: "system prompt ".repeat(50),
			tools: TOOLS,
			messages,
			contextWindow: 200_000,
		});

		const lines = renderContextBox({ breakdown, model: "anthropic/claude-sonnet-4-5" }, 100);
		const text = lines.join("\n");

		expect(text).toContain("Context");
		expect(text).toContain("anthropic/claude-sonnet-4-5");
		expect(text).toContain("Estimated (chars/4)");
		expect(text).toContain("System prompt + files");
		expect(text).toContain("Tool definitions");
		expect(text).toContain("User messages");
		expect(text).toContain("Assistant text");
		expect(text).toContain("Thinking");
		expect(text).toContain("Estimated total");
		expect(text).toContain("░");
		// Bordered box chrome
		expect(lines[0]).toContain("╭");
		expect(lines[lines.length - 1]).toContain("╰");
	});

	it("hides zero-token categories", () => {
		const breakdown = computeContextBreakdown({
			systemPrompt: "x".repeat(40),
			tools: [],
			messages: [createUserMessage("hi")],
			contextWindow: 200_000,
		});
		const text = renderContextBox({ breakdown }, 80).join("\n");
		expect(text).not.toContain("Thinking");
		expect(text).not.toContain("Tool results");
		expect(text).not.toContain("Summaries");
	});

	it("message estimate matches estimateContextTokens when no usage data", () => {
		const messages: AgentMessage[] = [createUserMessage("g".repeat(800)), createUserMessage("h".repeat(400))];
		const breakdown = computeContextBreakdown({
			systemPrompt: "",
			tools: [],
			messages,
			contextWindow: 200_000,
		});
		// Messages without valid usage: estimateContextTokens is a pure estimate.
		const estimate = estimateContextTokens(messages);
		expect(estimate.lastUsageIndex).toBeNull();
		expect(breakdown.user).toBe(estimate.tokens);
	});
});
