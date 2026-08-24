import { describe, expect, test } from "vitest";
import { THINKING_TAIL_LINES, ThinkingTailComponent } from "../src/modes/interactive/components/thinking-tail.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderPlain(component: ThinkingTailComponent, width: number): string[] {
	return component.render(width).map((line) => stripAnsi(line));
}

describe("ThinkingTailComponent", () => {
	test("does not pad short input to THINKING_TAIL_LINES", () => {
		initTheme("moon");

		const component = new ThinkingTailComponent("line one", 1, 0, getMarkdownTheme());
		const lines = renderPlain(component, 80);

		expect(lines.length).toBeLessThan(THINKING_TAIL_LINES);
		expect(lines.some((line) => line.includes("line one"))).toBe(true);
		expect(lines.filter((line) => line.trim() === "")).toHaveLength(0);
	});

	test("keeps only the last rendered lines of long input", () => {
		initTheme("moon");

		const source = Array.from({ length: 10 }, (_, i) => `thought-${String(i + 1).padStart(2, "0")}`).join("\n");
		const component = new ThinkingTailComponent(source, 1, 0, getMarkdownTheme());
		const lines = renderPlain(component, 80);

		expect(lines).toHaveLength(THINKING_TAIL_LINES);
		expect(lines.some((line) => line.includes("thought-01"))).toBe(false);
		expect(lines.some((line) => line.includes("thought-06"))).toBe(false);
		for (const n of ["07", "08", "09", "10"]) {
			expect(lines.some((line) => line.includes(`thought-${n}`))).toBe(true);
		}
	});

	test("window counts rendered lines, not source lines (wrapping)", () => {
		initTheme("moon");

		// One long source line that wraps to many rendered lines at width 20.
		const longLine = `STARTTOKEN ${"wrap ".repeat(40).trim()} ENDTOKEN`;
		const component = new ThinkingTailComponent(longLine, 1, 0, getMarkdownTheme());
		const lines = renderPlain(component, 20);

		expect(lines).toHaveLength(THINKING_TAIL_LINES);
		expect(lines.some((line) => line.includes("STARTTOKEN"))).toBe(false);
		expect(lines.some((line) => line.includes("ENDTOKEN"))).toBe(true);
	});

	test("invalidate delegates to the child and re-renders cleanly", () => {
		initTheme("moon");

		const component = new ThinkingTailComponent("alpha\nbeta", 1, 0, getMarkdownTheme());
		renderPlain(component, 80);
		component.invalidate();
		const lines = renderPlain(component, 40);

		expect(lines.some((line) => line.includes("alpha"))).toBe(true);
		expect(lines.some((line) => line.includes("beta"))).toBe(true);
	});
});
