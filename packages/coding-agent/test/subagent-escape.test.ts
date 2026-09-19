import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSubagentCancellation,
	getSubagentCancellation,
	registerSubagentCancellation,
	SubagentEscapeSequence,
} from "../src/core/subagent-cancellation.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

function fixture(active = true) {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	const stop = vi.fn(async () => ({ requested: 2, failed: 0 }));
	cleanups.push(registerSubagentCancellation("session", { hasActiveRuns: () => active, stop }));
	const editor = {
		onEscape: undefined as (() => void) | undefined,
		onAction: vi.fn(),
		getText: () => "draft",
		setText: vi.fn(),
	};
	const mode = {
		defaultEditor: editor,
		editor,
		session: { sessionId: "session", isStreaming: true, isBashRunning: false, abortBash: vi.fn() },
		subagentEscape: new SubagentEscapeSequence(),
		lastEscapeTime: 0,
		restoreQueuedMessagesToEditor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		settingsManager: { getDoubleEscapeAction: () => "tree" },
		ui: { addInputListener: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as { setupKeyHandlers(this: typeof mode): void };
	prototype.setupKeyHandlers.call(mode);
	return { mode, editor, stop };
}

describe("Escape with async children", () => {
	it("waits for pending launch registration and coalesces overlapping stop requests", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runs: string[] = [];
		const stopRun = vi.fn(async () => true);
		const cancellation = createSubagentCancellation({
			pendingLaunches: new Set([pending]),
			getActiveRunIds: () => runs,
			isCurrent: () => true,
			stopRun,
		});
		expect(cancellation.hasActiveRuns()).toBe(true);
		const first = cancellation.stop();
		expect(cancellation.stop()).toBe(first);
		expect(stopRun).not.toHaveBeenCalled();
		runs.push("just-registered");
		release();
		expect(await first).toEqual({ requested: 1, failed: 0 });
		expect(stopRun).toHaveBeenCalledExactlyOnceWith("just-registered");
	});
	it("abandons pending cancellation when the session is replaced", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let current = true;
		const stopRun = vi.fn(async () => true);
		const cancellation = createSubagentCancellation({
			pendingLaunches: new Set([pending]),
			getActiveRunIds: () => ["old"],
			isCurrent: () => current,
			stopRun,
		});
		const stopping = cancellation.stop();
		current = false;
		release();
		expect(await stopping).toEqual({ requested: 0, failed: 0 });
		expect(stopRun).not.toHaveBeenCalled();
	});

	it("aborts the parent once, then stops children even before streaming has settled", async () => {
		const { mode, editor, stop } = fixture();
		editor.onEscape!();
		expect(mode.restoreQueuedMessagesToEditor).toHaveBeenCalledOnce();
		expect(stop).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		editor.onEscape!();
		await Promise.resolve();
		expect(stop).toHaveBeenCalledOnce();
		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(editor.setText).not.toHaveBeenCalled();
		expect(mode.showStatus).toHaveBeenCalledWith("Stopping 2 async runs");
	});
	it("allows double Escape while idle with a draft", () => {
		const { mode, editor, stop } = fixture();
		mode.session.isStreaming = false;
		editor.onEscape!();
		editor.onEscape!();
		expect(stop).toHaveBeenCalledOnce();
		expect(editor.setText).not.toHaveBeenCalled();
	});
	it("keeps idle tree navigation when no async runs exist", () => {
		const { mode, editor, stop } = fixture(false);
		mode.session.isStreaming = false;
		editor.getText = () => "";
		editor.onEscape!();
		editor.onEscape!();
		expect(mode.showTreeSelector).toHaveBeenCalledOnce();
		expect(stop).not.toHaveBeenCalled();
	});
	it("expires the second-press window and never carries it into another session", () => {
		const sequence = new SubagentEscapeSequence();
		expect(sequence.press("one", true, 0)).toBe("parent");
		expect(sequence.press("one", true, 500)).toBe("parent");
		expect(sequence.press("two", true, 550)).toBe("parent");
		expect(sequence.press("two", true, 600)).toBe("children");
	});
	it("does not let stale cleanup unregister a replacement session handler", () => {
		const handler = { hasActiveRuns: () => true, stop: async () => ({ requested: 0, failed: 0 }) };
		const old = registerSubagentCancellation("replacement", handler);
		const replacement = { ...handler };
		cleanups.push(registerSubagentCancellation("replacement", replacement));
		old();
		expect(getSubagentCancellation("replacement")).toBe(replacement);
	});
});
