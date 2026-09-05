import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	formatThoughtDuration,
	isThinkingRunComplete,
	type ThinkingRunTiming,
	thinkingSnippet,
	updateThinkingRunTimings,
} from "../src/modes/interactive/components/thinking-summary.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

describe("thinkingSnippet", () => {
	test("returns the first sentence of the first substantive line", () => {
		expect(thinkingSnippet("I need to check the fork path. Then I edit it.")).toBe("I need to check the fork path.");
	});

	test("skips blank and markdown-only lines", () => {
		expect(thinkingSnippet("\n\n## Plan\n\nFirst real sentence here.")).toBe("First real sentence here.");
	});

	test("strips leading markdown characters", () => {
		expect(thinkingSnippet("- **Check** the rollback context. More follows.")).toBe("Check** the rollback context.");
	});

	test("collapses internal whitespace", () => {
		expect(thinkingSnippet("too   many\n\tspaces here.")).toBe("too many spaces here.");
	});

	test("takes a sentence across the first line break", () => {
		expect(thinkingSnippet("First part\ncontinues here. Second sentence.")).toBe("First part continues here.");
	});

	test("returns the line as-is when it fits without a terminator", () => {
		expect(thinkingSnippet("no terminator here")).toBe("no terminator here");
	});

	test("hard-truncates at a word boundary with an ellipsis when no terminator fits", () => {
		const long = `${"word ".repeat(40)}end`;
		const snippet = thinkingSnippet(long, 50);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(51);
	});

	test("keeps a long sentence intact when it fits within maxLen", () => {
		const sentence = `${"word ".repeat(20)}done.`;
		expect(thinkingSnippet(sentence, 200)).toBe(sentence);
	});

	test("returns empty string for empty thinking", () => {
		expect(thinkingSnippet("")).toBe("");
		expect(thinkingSnippet("\n\n  \n")).toBe("");
	});
});

describe("formatThoughtDuration", () => {
	test("formats sub-second as <1s", () => {
		expect(formatThoughtDuration(400)).toBe("<1s");
	});

	test("formats seconds", () => {
		expect(formatThoughtDuration(8000)).toBe("8s");
	});

	test("formats minutes and seconds", () => {
		expect(formatThoughtDuration(75000)).toBe("1m 15s");
		expect(formatThoughtDuration(120000)).toBe("2m");
	});
});

describe("updateThinkingRunTimings", () => {
	test("starts a run on first sight and ends it when a block follows", () => {
		const timings: ThinkingRunTiming[] = [];
		const partial: AssistantMessage["content"] = [{ type: "thinking", thinking: "reasoning" }];
		updateThinkingRunTimings(timings, partial, 1000, false);
		expect(timings).toEqual([{ start: 1000 }]);

		const withText: AssistantMessage["content"] = [...partial, { type: "text", text: "answer" }];
		updateThinkingRunTimings(timings, withText, 5000, false);
		expect(timings).toEqual([{ start: 1000, end: 5000 }]);
	});

	test("ends a trailing run only when final", () => {
		const timings: ThinkingRunTiming[] = [];
		const partial: AssistantMessage["content"] = [{ type: "thinking", thinking: "reasoning" }];
		updateThinkingRunTimings(timings, partial, 1000, false);
		expect(timings[0].end).toBeUndefined();
		updateThinkingRunTimings(timings, partial, 3000, true);
		expect(timings[0].end).toBe(3000);
	});

	test("tracks multiple runs independently and never double-ends", () => {
		const timings: ThinkingRunTiming[] = [];
		const step1: AssistantMessage["content"] = [{ type: "thinking", thinking: "run one" }];
		updateThinkingRunTimings(timings, step1, 100, false);
		const step2: AssistantMessage["content"] = [...step1, { type: "text", text: "text" }];
		updateThinkingRunTimings(timings, step2, 200, false);
		const step3: AssistantMessage["content"] = [...step2, { type: "thinking", thinking: "run two" }];
		updateThinkingRunTimings(timings, step3, 300, false);
		updateThinkingRunTimings(timings, step3, 400, true);

		expect(timings).toEqual([
			{ start: 100, end: 200 },
			{ start: 300, end: 400 },
		]);
		// Re-running with a later timestamp must not move the ends.
		updateThinkingRunTimings(timings, step3, 999, true);
		expect(timings).toEqual([
			{ start: 100, end: 200 },
			{ start: 300, end: 400 },
		]);
	});
});

describe("isThinkingRunComplete", () => {
	test("stays incomplete while timings are attached and end is unset, even with a following block", () => {
		expect(isThinkingRunComplete(true, { start: 1 }, true)).toBe(false);
		expect(isThinkingRunComplete(true, undefined, true)).toBe(false);
	});

	test("complete when the live timing has an end", () => {
		expect(isThinkingRunComplete(false, { start: 1, end: 2 }, true)).toBe(true);
	});

	test("incomplete while streaming with an open timing", () => {
		expect(isThinkingRunComplete(false, { start: 1 }, true)).toBe(false);
	});

	test("complete when no timings are attached (history message)", () => {
		expect(isThinkingRunComplete(false, undefined, false)).toBe(true);
	});
});

describe("AssistantMessageComponent collapsed thinking", () => {
	test("collapses a completed run to a label and first sentence", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "I need to check the fork path. Then I edit it." },
				{ type: "text", text: "answer" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
			true,
		);
		component.setThinkingTimings([{ start: 0, end: 8000 }]);
		// Re-render after attaching timings (setter alone does not re-render).
		component.setThinkingCollapse(true);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("✻ Thought for 8s");
		expect(rendered).toContain("I need to check the fork path.");
		expect(rendered).not.toContain("Then I edit it.");
		expect(rendered).toContain("answer");
	});

	test("renders a bare label for history messages without timings", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "Old reasoning. Details follow." },
				{ type: "text", text: "answer" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("✻ Thought");
		expect(rendered).not.toContain("✻ Thought for");
		expect(rendered).toContain("Old reasoning.");
	});

	test("keeps streaming runs fully visible until complete", () => {
		initTheme("moon");

		const message = createAssistantMessage([{ type: "thinking", thinking: "still reasoning along" }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, true);
		component.setThinkingTimings([{ start: 0 }]);
		component.setThinkingCollapse(true);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("still reasoning along");
		expect(rendered).not.toContain("✻ Thought");
	});

	test("collapse disabled renders the full block", () => {
		initTheme("moon");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "full reasoning stays. Second sentence." },
				{ type: "text", text: "answer" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
			false,
			false,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("Second sentence.");
		expect(rendered).not.toContain("✻ Thought");
	});
});
