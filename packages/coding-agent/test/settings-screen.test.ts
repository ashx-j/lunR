import { describe, expect, it, vi } from "vitest";
import type { SettingsCallbacks } from "../src/modes/interactive/components/settings-selector.ts";

// Captures the callbacks the screen hands to the settings list instead of drawing it.
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

import { type SettingsScreenHost, showSettingsSelector } from "../src/modes/interactive/settings-screen.ts";

describe("/settings", () => {
	it("writes a hide-thinking change through to the host's display state and redraws the chat", async () => {
		let hidden = false;
		const host = {
			session: { getAvailableThinkingLevels: () => [], getCompactionCeilingFloor: () => ({ floor: 0 }) },
			settingsManager: new Proxy({}, { get: () => () => undefined }),
			themeController: { getTerminalTheme: () => undefined },
			chatContainer: { children: [] },
			get hideThinkingBlock() {
				return hidden;
			},
			set hideThinkingBlock(value: boolean) {
				hidden = value;
			},
			showSelector: (create: (done: () => void) => unknown) => create(() => {}),
			rebuildChatFromMessages: vi.fn(),
		};
		await showSettingsSelector(host as unknown as SettingsScreenHost);
		captured.callbacks?.onHideThinkingBlockChange(true);
		expect(hidden).toBe(true);
		expect(host.rebuildChatFromMessages).toHaveBeenCalledOnce();
	});
});
