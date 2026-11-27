import { vi } from "vitest";
import type { SessionExitHost } from "../src/modes/interactive/session-exit.ts";

type ExitHostParts = Omit<Partial<SessionExitHost>, "ui"> & { ui?: Partial<SessionExitHost["ui"]> };

/** A complete SessionExitHost for tests: inert defaults, overridden by `parts` (`ui` merges member by member). */
export function createExitHost(parts: ExitHostParts = {}): SessionExitHost {
	const { ui, ...rest } = parts;
	return {
		session: { stopAdmission: vi.fn() },
		runtimeHost: { dispose: vi.fn(async () => {}) },
		editor: { getText: () => "" },
		chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
		themeController: { disableAutoSync: vi.fn() },
		exitConfirmation: { press: () => false, hint: "", clearHintOnExpiry: vi.fn() },
		shutdownRequested: false,
		unregisterSessionTransfer: undefined,
		clearEditor: vi.fn(),
		stopSmoothStreaming: vi.fn(),
		stopPlanUsagePolling: vi.fn(),
		stop: vi.fn(),
		confirmDisclaimerWithLabels: vi.fn(async () => false),
		showStatus: vi.fn(),
		...rest,
		ui: {
			requestRender: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			terminal: { drainInput: vi.fn(async () => {}) },
			...ui,
		},
	};
}
