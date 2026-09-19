import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { parseCopyableTextSegments } from "../src/modes/interactive/components/copyable-text.ts";
import { sliceMessageContent } from "../src/modes/interactive/smooth-streaming.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6",
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

function fence(marker: string, info: string, payload: string): string {
	return `${marker}${info}\n${payload}\n${marker}`;
}

function buttonPosition(component: AssistantMessageComponent, width: number, occurrence = 0): { x: number; y: number } {
	const lines = component.render(width).map((line) => stripAnsi(line));
	const matches = lines.map((line, y) => ({ x: line.indexOf("[ Copy ]"), y })).filter(({ x }) => x >= 0);
	const position = matches[occurrence];
	if (!position) throw new Error(`Copy button ${occurrence} was not rendered`);
	return position;
}

async function settleCopy(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("lunr-copy parsing", () => {
	test("preserves exact payload boundaries and surrounding prose", () => {
		const source = "before\r\n\r\n```lunr-copy\r\n\r\n  first  \r\n\r\n```\r\nafter";
		expect(parseCopyableTextSegments(source)).toEqual([
			{ type: "markdown", text: "before\r\n\r\n" },
			{ type: "copyable", payload: "\r\n  first  \r\n", complete: true, start: 10 },
			{ type: "markdown", text: "after" },
		]);
	});

	test("allows longer backtick and tilde wrappers around nested fences", () => {
		const backticks = ["````lunr-copy", "```ts", "const value = 1;", "```", "````"].join("\n");
		const tildes = ["~~~~~ lunr-copy", "~~~text", "nested", "~~~", "~~~~~"].join("\n");
		expect(parseCopyableTextSegments(backticks)).toEqual([
			{ type: "copyable", payload: "```ts\nconst value = 1;\n```", complete: true, start: 0 },
		]);
		expect(parseCopyableTextSegments(tildes)).toEqual([
			{ type: "copyable", payload: "~~~text\nnested\n~~~", complete: true, start: 0 },
		]);
	});

	test("does not detect lunr-copy markers inside an ordinary fenced example", () => {
		const source = ["````markdown", "```lunr-copy", "not active", "```", "````"].join("\n");
		expect(parseCopyableTextSegments(source)).toEqual([{ type: "markdown", text: source }]);
	});

	test("leaves malformed markers as markdown and marks an unclosed valid fence incomplete", () => {
		const malformed = fence("```", "lunr-copy extra", "plain code");
		expect(parseCopyableTextSegments(malformed)).toEqual([{ type: "markdown", text: malformed }]);
		expect(parseCopyableTextSegments("intro\n```lunr-copy\n  partial\n")).toEqual([
			{ type: "markdown", text: "intro\n" },
			{ type: "copyable", payload: "  partial\n", complete: false, start: 6 },
		]);
	});
});

describe("AssistantMessageComponent lunr-copy blocks", () => {
	test("copies exact payloads from independent buttons", async () => {
		initTheme("moon");
		const copied: string[] = [];
		const source = [
			"Use either value.",
			"",
			"```lunr-copy",
			"  first  ",
			"",
			"```",
			"Between blocks.",
			"~~~lunr-copy",
			"second\tvalue",
			"~~~",
		].join("\n");
		const component = new AssistantMessageComponent(
			createAssistantMessage(source),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			{ copyText: async (text) => void copied.push(text) },
		);

		expect(copied).toEqual([]);
		const first = buttonPosition(component, 60, 0);
		expect(component.handleClick(first.y, 60, first.x)).toBe(true);
		await settleCopy();
		expect(copied).toEqual(["  first  \n"]);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("Copied");

		const second = buttonPosition(component, 60, 1);
		expect(component.handleClick(second.y, 60, second.x)).toBe(true);
		await settleCopy();
		expect(copied).toEqual(["  first  \n", "second\tvalue"]);
	});

	test("requires a click inside the button and recalculates hit rows after resize", async () => {
		initTheme("moon");
		const copyText = vi.fn(async () => {});
		const source = fence("```", "lunr-copy", "a long payload that wraps at a narrow width");
		const component = new AssistantMessageComponent(
			createAssistantMessage(source),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			{ copyText },
		);

		const wide = buttonPosition(component, 70);
		expect(component.handleClick(wide.y, 70, wide.x - 1)).toBe(false);
		expect(component.handleClick(wide.y, 70, wide.x + "[ Copy ]".length)).toBe(false);

		const narrow = buttonPosition(component, 24);
		expect(narrow.y).toBeGreaterThan(wide.y);
		expect(component.handleClick(narrow.y, 24, narrow.x)).toBe(true);
		await settleCopy();
		expect(copyText).toHaveBeenCalledWith("a long payload that wraps at a narrow width");
	});

	test("reconstructs buttons from saved message text", () => {
		initTheme("moon");
		const message = createAssistantMessage(fence("```", "lunr-copy", "saved payload"));
		const firstRender = new AssistantMessageComponent(message);
		const historyRender = new AssistantMessageComponent(message);
		expect(buttonPosition(firstRender, 50)).toEqual(buttonPosition(historyRender, 50));
	});

	test("shows incomplete streamed payloads without a button until the closing fence is revealed", () => {
		initTheme("moon");
		const source = fence("```", "lunr-copy", "streamed payload");
		const full = createAssistantMessage(source);
		const component = new AssistantMessageComponent();
		component.updateContent(sliceMessageContent(full, source.length - 2), { thinkingSource: full });
		let rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("streamed payload");
		expect(rendered).not.toContain("[ Copy ]");

		component.updateContent(sliceMessageContent(full, source.length), { thinkingSource: full });
		rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("[ Copy ]");
	});

	test("reports clipboard failure without showing success", async () => {
		initTheme("moon");
		const requestRender = vi.fn();
		const component = new AssistantMessageComponent(
			createAssistantMessage(fence("```", "lunr-copy", "cannot copy")),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			{
				copyText: async () => {
					throw new Error("clipboard unavailable");
				},
				requestRender,
			},
		);
		const button = buttonPosition(component, 60);
		expect(component.handleClick(button.y, 60, button.x)).toBe(true);
		await settleCopy();

		const rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("Copy failed: clipboard unavailable");
		expect(rendered).not.toContain("  Copied");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
