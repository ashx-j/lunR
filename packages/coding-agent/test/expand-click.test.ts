import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// app.tools.expand has no default key, so collapsed cards say "click" and expand on a click.
describe("collapsed cards without an expand key", () => {
	beforeAll(() => {
		initTheme("moon", false);
	});

	it("a compaction summary says click to expand and a click expands it", () => {
		const card = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "the full summary text",
			tokensBefore: 1200,
			timestamp: 0,
		});
		expect(stripAnsi(card.render(80).join("\n"))).toContain("(click to expand)");
		expect(card.handleClick(0, 80)).toBe(true);
		expect(stripAnsi(card.render(80).join("\n"))).toContain("the full summary text");
	});

	it("bash output says click to expand and a click shows every line", () => {
		const ui = { addInterval: () => ({ dispose: () => {} }), removeInterval: () => {}, requestRender: () => {} };
		const card = new BashExecutionComponent("seq 30", ui as unknown as TUI);
		card.appendOutput(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
		card.setComplete(0, false);
		expect(stripAnsi(card.render(80).join("\n"))).toContain("more lines (click to expand)");
		expect(card.handleClick(0, 80)).toBe(true);
		const expanded = stripAnsi(card.render(80).join("\n"));
		expect(expanded).toMatch(/line 1 *$/m);
		expect(expanded).toContain("click to collapse");
	});
});
