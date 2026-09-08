import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface CompactionEndEvent {
	type: "compaction_end";
	reason: "manual" | "threshold" | "overflow";
	result: { tokensBefore: number; summary: string } | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
}

function createFakeMode(isIdle: boolean) {
	const fakeThis = {
		isInitialized: true,
		session: { isIdle },
		footer: { invalidate: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		autoCompactionLoader: undefined,
		pendingCompactionRender: undefined as { tokensBefore: number; summary: string } | undefined,
		defaultEditor: {},
		statusContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn() },
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		clearStatusIndicator: vi.fn(),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: ReturnType<typeof createFakeMode>,
	event: CompactionEndEvent | { type: "agent_settled" },
) => Promise<void>;

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = createFakeMode(true);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("defers rebuilding chat until a live turn settles", async () => {
		const fakeThis = createFakeMode(false);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: {
				tokensBefore: 456,
				summary: "mid-turn summary",
			},
			aborted: false,
			willRetry: true,
		});

		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.pendingCompactionRender).toEqual({ tokensBefore: 456, summary: "mid-turn summary" });
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });

		fakeThis.session.isIdle = true;
		await handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 456,
				summary: "mid-turn summary",
			}),
		);
		expect(fakeThis.pendingCompactionRender).toBeUndefined();
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});
});
