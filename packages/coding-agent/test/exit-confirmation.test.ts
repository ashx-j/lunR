import { describe, expect, it, vi } from "vitest";
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

	it("removes the hint when the window closes, and an older hint as soon as a new one shows", () => {
		vi.useFakeTimers();
		try {
			const exit = new ExitConfirmation();
			const first = vi.fn();
			const second = vi.fn();
			exit.clearHintOnExpiry(first);
			vi.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS - 1);
			expect(first).not.toHaveBeenCalled();
			exit.clearHintOnExpiry(second);
			expect(first).toHaveBeenCalledOnce();
			vi.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS);
			expect(second).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
