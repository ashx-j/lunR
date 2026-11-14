import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const SHIFT_TAB = "\x1b[Z";
const fakeTui = { requestRender: () => {} } as unknown as TUI;

describe("ModelSelectorComponent permission mode cycle", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("moon"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createSelector(options: { onCyclePermissionMode?: () => void }) {
		const harness = await createHarness({ models: [{ id: "faux-1", name: "One" }] });
		harnesses.push(harness);
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			fakeTui,
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			onCancel,
			undefined,
			{ persistDefault: false, title: "Pick the reviewer", ...options },
		);
		return { selector, onCancel };
	}

	it("hands Shift+Tab to the cycle callback instead of cancelling", async () => {
		const onCyclePermissionMode = vi.fn();
		const { selector, onCancel } = await createSelector({ onCyclePermissionMode });
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Pick the reviewer");
		selector.handleInput(SHIFT_TAB);
		expect(onCyclePermissionMode).toHaveBeenCalledOnce();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("ignores Shift+Tab without the callback", async () => {
		const { selector, onCancel } = await createSelector({});
		selector.handleInput(SHIFT_TAB);
		expect(onCancel).not.toHaveBeenCalled();
	});
});
