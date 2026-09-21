import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	THINKING_TAIL_LINES,
	ThinkingLineComponent,
	ThinkingTailComponent,
} from "../src/modes/interactive/components/thinking-tail.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderPlain(component: ThinkingTailComponent, width: number): string[] {
	return component.render(width).map((line) => stripAnsi(line));
}

describe("ThinkingLineComponent", () => {
	test("keeps the latest nonempty visual line with one blank row on each side", () => {
		initTheme("moon");
		const component = new ThinkingLineComponent("old\n\n**latest**\n\n", 1, getMarkdownTheme(), 0);
		expect(component.render(80).map((line) => stripAnsi(line).trim())).toEqual(["", "latest", ""]);
	});

	test("respects narrow widths and keeps emoji and combining characters intact", () => {
		initTheme("moon");
		const component = new ThinkingLineComponent("old\n界 é 👩‍💻", 0, getMarkdownTheme(), 0);
		for (const width of [0, 1, 8, 20]) {
			expect(component.render(width)).toHaveLength(3);
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const line = component.render(20)[1];
		expect(line).toContain("é");
		expect(line).toContain("👩‍💻");
	});

	test("moves a broad graduated band rightward without changing text or spacing", () => {
		initTheme("moon");
		const clock = vi.spyOn(performance, "now");
		try {
			const component = new ThinkingLineComponent(
				"abcdefghijklmnopqrstuvwxyzabcdefghijklmn",
				0,
				getMarkdownTheme(),
				0,
			);
			clock.mockReturnValue(1000);
			const first = component.render(80);
			clock.mockReturnValue(1500);
			const second = component.render(80);
			expect(first.map(stripAnsi)).toEqual(second.map(stripAnsi));
			expect(first[1]).not.toEqual(second[1]);
			const colorCodes = (line: string) =>
				[...line.matchAll(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g)].map((match) => match[0]);
			const a = colorCodes(first[1]);
			const b = colorCodes(second[1]);
			const changed = (colors: string[]) => colors.flatMap((color, i) => (color !== colors[0] ? [i] : []));
			expect(new Set(a).size).toBeGreaterThan(4);
			expect(changed(a).length).toBeGreaterThan(6);
			expect(changed(b)[0]).toBeGreaterThan(changed(a)[0]);
			clock.mockReturnValue(1000 + 2800);
			expect(component.render(80)).toEqual(first);
		} finally {
			clock.mockRestore();
		}
	});
});

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
