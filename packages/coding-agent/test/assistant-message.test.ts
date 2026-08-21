import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { THINKING_TAIL_LINES } from "../src/modes/interactive/components/thinking-tail.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { sliceMessageContent } from "../src/modes/interactive/smooth-streaming.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
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
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops as visible errors", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		// lunr: thinking blocks are hidden — no Thinking... label should appear.
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("hides thinking blocks without a label when hideThinkingBlock is true", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		// lunr: no Thinking... label when hidden; visible text follows immediately.
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).toContain("answer");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" ● hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("● hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("moon");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" ● hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("● hello"))).toBe(true);
	});

	// lunr: ctrl+o expansion of collapsed reasoning (Expandable interface).
	function createCollapsedThinkingComponent(): AssistantMessageComponent {
		// thinkingCollapse=true, no timings attached → history message → run is complete.
		return new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "First sentence of reasoning. More detail follows here." },
				{ type: "text", text: "answer" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			true,
		);
	}

	test("collapsed thinking runs show the summary line by default", () => {
		initTheme("moon");

		const component = createCollapsedThinkingComponent();
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("✻ Thought");
		expect(rendered).toContain("First sentence of reasoning.");
		expect(rendered).not.toContain("More detail follows here.");
	});

	test("setExpanded(true) renders the full thinking block", () => {
		initTheme("moon");

		const component = createCollapsedThinkingComponent();
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).not.toContain("✻ Thought");
		expect(rendered).toContain("First sentence of reasoning. More detail follows here.");
	});

	test("setExpanded(false) re-collapses the thinking run", () => {
		initTheme("moon");

		const component = createCollapsedThinkingComponent();
		component.setExpanded(true);
		component.setExpanded(false);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("✻ Thought");
		expect(rendered).not.toContain("More detail follows here.");
	});

	// lunr: rolling window — a still-streaming thinking run (timings attached,
	// no end, no following block) shows only its last THINKING_TAIL_LINES lines.
	function createStreamingThinkingComponent(): AssistantMessageComponent {
		const source = Array.from({ length: 10 }, (_, i) => `streamed thought ${String(i + 1).padStart(2, "0")}`).join(
			"\n",
		);
		// Mirror interactive-mode: construct empty, attach live timings, then updateContent.
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, false, true);
		component.setThinkingTimings([{ start: Date.now() }]);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: source }]));
		return component;
	}

	test("a streaming thinking run renders at most THINKING_TAIL_LINES lines", () => {
		initTheme("moon");

		const component = createStreamingThinkingComponent();
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes("streamed thought 01"))).toBe(false);
		expect(lines.some((line) => line.includes("streamed thought 06"))).toBe(false);
		for (const n of ["07", "08", "09", "10"]) {
			expect(lines.some((line) => line.includes(`streamed thought ${n}`))).toBe(true);
		}
	});

	test("setExpanded(true) renders a streaming thinking run in full", () => {
		initTheme("moon");

		const component = createStreamingThinkingComponent();
		component.setExpanded(true);
		const lines = component.render(80).map((line) => stripAnsi(line));

		for (const n of ["01", "05", "10"]) {
			expect(lines.some((line) => line.includes(`streamed thought ${n}`))).toBe(true);
		}
	});

	test("a streaming thinking run occupies THINKING_TAIL_LINES and shows the latest chunk", () => {
		initTheme("moon");

		const thinking = `${"alpha ".repeat(8).trim()}\nlatest-chunk-xyz`;
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, false, true);
		component.setThinkingTimings([{ start: Date.now() }]);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking }]));
		const lines = component.render(80).map((line) => stripAnsi(line));
		const thinkingLines = lines.filter((line) => line.trim().length > 0 && !line.includes("●"));

		expect(lines.join("\n")).not.toContain("✻ Thought");
		expect(thinkingLines.length).toBeLessThanOrEqual(THINKING_TAIL_LINES);
		expect(lines.some((line) => line.includes("latest-chunk-xyz"))).toBe(true);
	});

	test("smooth-sliced prefix still shows the tail of the full thinking string", () => {
		initTheme("moon");

		const thinking = `${"A".repeat(80)} UNIQUE_TAIL_CHUNK`;
		const full = createAssistantMessage([{ type: "thinking", thinking }]);
		const sliced = sliceMessageContent(full, 10, {});
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, false, true);
		component.setThinkingTimings([{ start: Date.now() }]);
		component.updateContent(sliced, { thinkingSource: full });
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(rendered).not.toContain("✻ Thought");
		expect(rendered).toContain("UNIQUE_TAIL_CHUNK");
	});

	test("history messages still collapse when thinkingCollapse is true", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "Old reasoning. Details follow." }]),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("✻ Thought");
		expect(rendered).toContain("Old reasoning.");
		expect(rendered).not.toContain("Details follow.");
	});
});
