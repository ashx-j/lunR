import { describe, expect, test } from "vitest";
import { TUI } from "../../tui/src/tui.ts";
import { visibleWidth } from "../../tui/src/utils.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ChatboxEditor } from "../src/builtin-extensions/ashxj-tui.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";

describe("chatbox minimum column allocation", () => {
	for (const text of ["界", "🙂", "👨‍👩‍👧‍👦", "界\n".repeat(20)]) {
		test(`renders a narrow draft without exceeding its assigned columns: ${text.includes("\n") ? "multiline CJK" : text}`, () => {
			const editor = new ChatboxEditor(
				new TUI(new VirtualTerminal()),
				defaultEditorTheme,
				Object.assign(new KeybindingsManager(), { _: undefined }),
				{
					mode: "tui",
					hasUI: true,
					model: undefined,
					sessionManager: { getEntries: () => [] },
					getContextUsage: () => undefined,
					ui: { setEditorComponent() {}, setFooter() {} },
				},
				{ getThinkingLevel: () => "off", on() {} },
			);
			editor.focused = true;
			editor.setText(text);
			for (const width of [0, 1, 2, 4, 5, 6, 7]) {
				expect(editor.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
			}
			expect(editor.getText()).toBe(text);
		});
	}
});
