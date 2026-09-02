import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProcessesSelectorComponent } from "../src/modes/interactive/components/processes-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/core/process-registry.ts", () => ({
	isWindows: () => false,
	kill: vi.fn(),
	list: vi.fn(() => []),
	pause: vi.fn(),
	restart: vi.fn(),
	resume: vi.fn(),
}));

describe("ProcessesSelectorComponent", () => {
	beforeAll(() => initTheme(undefined, false));

	afterEach(() => {
		vi.useRealTimers();
	});

	it("requests a repaint on refresh and stops after idempotent disposal", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const selector = new ProcessesSelectorComponent(() => {}, requestRender);

		vi.advanceTimersByTime(2000);
		expect(requestRender).toHaveBeenCalledTimes(1);

		selector.dispose();
		selector.dispose();
		vi.advanceTimersByTime(4000);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
