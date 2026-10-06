import { describe, expect, it } from "vitest";
import { PrWatchDurationSubmenu } from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("PR watch duration settings menu", () => {
	it("shows all finite presets and no unlimited choice", () => {
		initTheme("moon");
		const selected: string[] = [];
		const menu = new PrWatchDurationSubmenu(1_800_000, (value) => {
			if (value) selected.push(value);
		});
		const rendered = menu.render(120).join("\n");
		for (const label of ["5 minutes", "10 minutes", "20 minutes", "30 minutes", "1 hour", "Custom minutes"])
			expect(rendered).toContain(label);
		expect(rendered).not.toContain("unlimited");
		menu.handleInput("\r");
		expect(selected).toEqual(["1800000"]);
	});

	it("accepts a positive finite custom duration and rejects zero or Infinity", () => {
		initTheme("moon");
		const selected: string[] = [];
		const menu = new PrWatchDurationSubmenu(90_000, (value) => {
			if (value) selected.push(value);
		});
		menu.handleInput("\r");
		for (const value of ["0", "Infinity", "2.5"]) {
			menu.handleInput("\x05");
			menu.handleInput("\x15");
			menu.handleInput(value);
			menu.handleInput("\r");
		}
		expect(selected).toEqual(["150000"]);
	});
});
