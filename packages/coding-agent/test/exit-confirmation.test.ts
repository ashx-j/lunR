import { describe, expect, it } from "vitest";
import { EXIT_CONFIRM_WINDOW_MS, ExitConfirmation } from "../src/modes/interactive/exit-confirmation.ts";

describe("ExitConfirmation", () => {
	it("exits only on a second press inside the window", () => {
		const exit = new ExitConfirmation();
		expect(exit.press(0)).toBe(false);
		expect(exit.press(EXIT_CONFIRM_WINDOW_MS - 1)).toBe(true);
		// A confirmed exit disarms, so the next press starts over.
		expect(exit.press(EXIT_CONFIRM_WINDOW_MS)).toBe(false);
	});

	it("re-arms instead of exiting when the second press is too late", () => {
		const exit = new ExitConfirmation();
		expect(exit.press(0)).toBe(false);
		expect(exit.press(EXIT_CONFIRM_WINDOW_MS)).toBe(false);
		expect(exit.press(EXIT_CONFIRM_WINDOW_MS + 100)).toBe(true);
	});
});
