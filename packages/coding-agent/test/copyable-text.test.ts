import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	CopyableTextBlockComponent,
	parseCopyableTextSegments,
} from "../src/modes/interactive/components/copyable-text.ts";
import { sliceMessageContent } from "../src/modes/interactive/smooth-streaming.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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

function payloadPosition(
	component: AssistantMessageComponent,
	width: number,
	payload: string,
): { x: number; y: number } {
	const lines = component.render(width).map((line) => stripAnsi(line));
	const y = lines.findIndex((line) => line.includes(payload));
	if (y < 0) throw new Error(`Payload "${payload}" was not rendered`);
	return { x: lines[y].indexOf(payload), y };
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

describe("CopyableTextBlockComponent", () => {
	test("renders a plain background box with one blank row above and below", () => {
		initTheme("moon");
		const component = new CopyableTextBlockComponent("plain text", true, 1, "idle", () => {});
		const lines = component.render(30);

		expect(lines[0]).toBe(theme.bg("userMessageBg", " ".repeat(30)));
		expect(lines.at(-1)).toBe(theme.bg("userMessageBg", " ".repeat(30)));
		expect(stripAnsi(lines.join("\n"))).toContain(" plain text");
		expect(stripAnsi(lines.join("\n"))).not.toMatch(/lunr-copy|\[ Copy \]|[╭╰│]/);
	});
});

describe("AssistantMessageComponent lunr-copy blocks", () => {
	test("copies exact payloads by clicking anywhere in each section", async () => {
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
		const first = payloadPosition(component, 60, "first");
		expect(component.handleClick(first.y, 60, 59)).toBe(true);
		await settleCopy();
		expect(copied).toEqual(["  first  \n"]);
		expect(stripAnsi(component.render(60).join("\n"))).not.toContain("Copied");

		const second = payloadPosition(component, 60, "second   value");
		expect(component.handleClick(second.y, 60, 0)).toBe(true);
		await settleCopy();
		expect(copied).toEqual(["  first  \n", "second\tvalue"]);
	});

	test("recalculates the full-section hit area after wrapping and resize", async () => {
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

		const wideBottom = component.render(70).length - 1;
		const narrowBottom = component.render(24).length - 1;
		expect(narrowBottom).toBeGreaterThan(wideBottom);
		expect(component.handleClick(narrowBottom, 24, 23)).toBe(true);
		await settleCopy();
		expect(copyText).toHaveBeenCalledWith("a long payload that wraps at a narrow width");
		expect(component.handleClick(narrowBottom, 24, 24)).toBe(false);
		expect(component.handleClick(narrowBottom + 1, 24, 0)).toBe(false);
	});

	test("reconstructs clickable sections from saved message text", async () => {
		initTheme("moon");
		const copyText = vi.fn(async () => {});
		const message = createAssistantMessage(fence("```", "lunr-copy", "saved payload"));
		const historyRender = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, false, {
			copyText,
		});
		const position = payloadPosition(historyRender, 50, "saved payload");
		expect(historyRender.handleClick(position.y, 50, position.x)).toBe(true);
		await settleCopy();
		expect(copyText).toHaveBeenCalledWith("saved payload");
	});

	test("shows incomplete streamed payloads but enables copying only after the closing fence is revealed", async () => {
		initTheme("moon");
		const copyText = vi.fn(async () => {});
		const source = fence("```", "lunr-copy", "streamed payload");
		const full = createAssistantMessage(source);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, false, {
			copyText,
		});
		component.updateContent(sliceMessageContent(full, source.length - 2), { thinkingSource: full });
		let position = payloadPosition(component, 60, "streamed payload");
		expect(component.handleClick(position.y, 60, position.x)).toBe(false);

		component.updateContent(sliceMessageContent(full, source.length), { thinkingSource: full });
		position = payloadPosition(component, 60, "streamed payload");
		expect(component.handleClick(position.y, 60, position.x)).toBe(true);
		await settleCopy();
		expect(copyText).toHaveBeenCalledWith("streamed payload");
	});

	test("reports clipboard failure inside the section without button clutter", async () => {
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
		const position = payloadPosition(component, 60, "cannot copy");
		expect(component.handleClick(position.y, 60, position.x)).toBe(true);
		await settleCopy();

		const rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("Copy failed: clipboard unavailable");
		expect(rendered).not.toMatch(/\[ Copy \]|Copied/);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
