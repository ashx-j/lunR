import assert from "node:assert";
import { describe, it } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";

describe("KeybindingsManager", () => {
	it("binds Ctrl+J as a default newline alias", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.input.newLine"), ["shift+enter", "ctrl+j"]);
		assert.strictEqual(keybindings.matches("\n", "tui.input.newLine"), true);
		assert.strictEqual(keybindings.matches("\x1b[106;5u", "tui.input.newLine"), true);
	});

	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});

	it("binds Ctrl+Backspace and Ctrl+Delete to word delete without changing Backspace", () => {
		const envNames = ["WT_SESSION", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
		const previous = envNames.map((name) => [name, process.env[name]] as const);
		for (const name of envNames) delete process.env[name];
		try {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.strictEqual(keybindings.matches("\x1b[127;5u", "tui.editor.deleteWordBackward"), true);
			assert.strictEqual(keybindings.matches("\x1b[3;5~", "tui.editor.deleteWordForward"), true);
			assert.strictEqual(keybindings.matches("\x7f", "tui.editor.deleteWordBackward"), false);
			// Outside Windows Terminal, raw 0x08 stays plain Backspace.
			assert.strictEqual(keybindings.matches("\x08", "tui.editor.deleteWordBackward"), false);
			assert.strictEqual(keybindings.matches("\x08", "tui.editor.deleteCharBackward"), true);

			// Windows Terminal sends 0x08 for Ctrl+Backspace and 0x7f for Backspace.
			process.env.WT_SESSION = "test";
			assert.strictEqual(keybindings.matches("\x08", "tui.editor.deleteWordBackward"), true);
			assert.strictEqual(keybindings.matches("\x7f", "tui.editor.deleteCharBackward"), true);
			assert.strictEqual(keybindings.matches("\x7f", "tui.editor.deleteWordBackward"), false);
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
