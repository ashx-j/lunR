import { describe, expect, it, vi } from "vitest";
import type { AttentionNotification } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type AttentionPrototype = {
	notifyAttention(this: unknown, reason: "finished" | "input"): void;
	notifyAttentionIfRunning(this: unknown): void;
};

const prototype = InteractiveMode.prototype as unknown as AttentionPrototype;

function fixture(mode: AttentionNotification, focused: boolean | undefined, isStreaming = true) {
	const notify = vi.fn();
	const self = {
		settingsManager: { getAttentionNotification: () => mode },
		ui: { isTerminalFocused: () => focused, notify },
		session: { isStreaming },
		notifyAttention: prototype.notifyAttention,
	};
	return { self, notify };
}

describe("attention notifications", () => {
	it("notifies through the chosen channel when the terminal is unfocused or does not report focus", () => {
		const unfocused = fixture("desktop", false);
		prototype.notifyAttention.call(unfocused.self, "finished");
		expect(unfocused.notify).toHaveBeenCalledWith("desktop", "lunR finished");

		const unknown = fixture("bell", undefined);
		prototype.notifyAttention.call(unknown.self, "input");
		expect(unknown.notify).toHaveBeenCalledWith("bell", "lunR needs your input");
	});

	it("stays quiet when off or while the terminal reports focus", () => {
		const off = fixture("off", false);
		prototype.notifyAttention.call(off.self, "finished");
		const focused = fixture("bell", true);
		prototype.notifyAttention.call(focused.self, "finished");
		expect(off.notify).not.toHaveBeenCalled();
		expect(focused.notify).not.toHaveBeenCalled();
	});

	it("treats extension questions as waiting only during a run", () => {
		const idle = fixture("bell", false, false);
		prototype.notifyAttentionIfRunning.call(idle.self);
		expect(idle.notify).not.toHaveBeenCalled();

		const running = fixture("bell", false, true);
		prototype.notifyAttentionIfRunning.call(running.self);
		expect(running.notify).toHaveBeenCalledWith("bell", "lunR needs your input");
	});
});
