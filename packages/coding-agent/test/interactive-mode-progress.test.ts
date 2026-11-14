import { afterEach, describe, expect, test, vi } from "vitest";
import { ProcessTerminal } from "../../tui/src/terminal.ts";
import type { Component } from "../../tui/src/tui.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SettingsCallbacks } from "../src/modes/interactive/components/settings-selector.ts";

const captured = vi.hoisted(() => ({ callbacks: undefined as SettingsCallbacks | undefined }));
vi.mock("../src/modes/interactive/components/settings-selector.ts", () => ({
	SettingsSelectorComponent: class {
		constructor(_config: unknown, callbacks: SettingsCallbacks) {
			captured.callbacks = callbacks;
		}
		getSettingsList() {
			return this;
		}
	},
}));

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createMode() {
	let enabled = true;
	const terminal = new ProcessTerminal();
	const setShowTerminalProgress = vi.fn((value: boolean) => {
		enabled = value;
	});
	const mode = {
		isInitialized: true,
		workingVisible: false,
		settingsManager: new Proxy(
			{},
			{
				get: (_target, name) => {
					if (name === "getShowTerminalProgress") return () => enabled;
					if (name === "setShowTerminalProgress") return setShowTerminalProgress;
					return () => undefined;
				},
			},
		),
		ui: { terminal, requestRender: vi.fn(), stop: vi.fn() },
		footer: { invalidate: vi.fn(), dispose: vi.fn() },
		footerDataProvider: { dispose: vi.fn() },
		session: { getAvailableThinkingLevels: () => [], isIdle: true, refreshModelFromRegistry: vi.fn() },
		sessionManager: { getCwd: () => "/inert", getSessionId: () => "inert" },
		themeController: { getTerminalTheme: () => undefined, disableAutoSync: vi.fn() },
		countSubscriptions: async () => 0,
		showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => create(() => {}),
		pendingTools: new Map(),
		defaultEditor: {},
		clearStatusIndicator: vi.fn(),
		stopSmoothStreaming: vi.fn(),
		maybeAutoNameSession: vi.fn(),
		showStatus: vi.fn(),
		flushCompactionQueue: vi.fn(),
		setThinkingAnimation: vi.fn(),
		clearExtensionTerminalInputListeners: vi.fn(),
		disposeChatToolComponents: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, setShowTerminalProgress };
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: ReturnType<typeof createMode>["mode"],
	event: AgentSessionEvent,
) => Promise<void>;
const showSettings = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (
	this: ReturnType<typeof createMode>["mode"],
) => Promise<void>;

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("InteractiveMode progress cleanup", () => {
	test("disabling progress in settings clears the terminal keepalive immediately", async () => {
		vi.useFakeTimers();
		const writes = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { mode, setShowTerminalProgress } = createMode();
		try {
			await handleEvent.call(mode, { type: "agent_start" });
			expect(vi.getTimerCount()).toBe(1);
			await showSettings.call(mode);
			captured.callbacks?.onShowTerminalProgressChange(false);
			expect(setShowTerminalProgress).toHaveBeenCalledWith(false);
			expect(vi.getTimerCount()).toBe(0);
			writes.mockClear();
			vi.advanceTimersByTime(30000);
			expect(writes).not.toHaveBeenCalled();
		} finally {
			mode.ui.terminal.setProgress(false);
		}
	});

	for (const termination of ["agent_end", "compaction_end", "stop"] as const) {
		test(`${termination} clears progress even after the saved preference changes`, async () => {
			vi.useFakeTimers();
			vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const { mode, setShowTerminalProgress } = createMode();
			try {
				mode.ui.terminal.setProgress(true);
				setShowTerminalProgress(false);
				if (termination === "stop") InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);
				else
					await handleEvent.call(
						mode,
						termination === "agent_end"
							? { type: "agent_end", messages: [], willRetry: false }
							: {
									type: "compaction_end",
									reason: "manual",
									result: undefined,
									aborted: false,
									willRetry: false,
								},
					);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				mode.ui.terminal.setProgress(false);
			}
		});
	}
});
