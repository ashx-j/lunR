import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Container, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const createEditor = () => new Editor(new TUI(new VirtualTerminal()), defaultEditorTheme);

describe("narrow editor source mapping", () => {
	it("keeps scroll indicators inside a one-column editor", () => {
		const editor = createEditor();
		editor.focused = true;
		editor.setText("界\n".repeat(20));
		editor.render(1);
		for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
		const rows = editor.render(1);
		assert.ok(rows.every((row) => visibleWidth(row) <= 1));
		assert.ok(rows.some((row) => row.includes(CURSOR_MARKER)));
	});

	for (const grapheme of ["界", "🙂", "👨‍👩‍👧‍👦"]) {
		it(`wraps ${grapheme} into bounded chunks without losing source offsets`, () => {
			const source = `a${grapheme}b`;
			const chunks = wordWrapLine(source, 1);
			assert.deepEqual(
				chunks.map(({ startIndex, endIndex }) => [startIndex, endIndex]),
				[
					[0, 1],
					[1, 1 + grapheme.length],
					[1 + grapheme.length, source.length],
				],
			);
			assert.ok(chunks.every((chunk) => visibleWidth(chunk.text) <= 1));
			assert.equal(wordWrapLine(grapheme, 0)[0]?.endIndex, grapheme.length);
		});

		it(`renders ${grapheme} at minimum width and retains cursor and submitted source`, () => {
			const editor = createEditor();
			editor.focused = true;
			editor.setText(`a${grapheme}b`);
			for (const width of [0, 1, 2]) {
				assert.ok(editor.render(width).every((row) => visibleWidth(row) <= width));
			}
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[D");
			assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
			assert.ok(editor.render(1).some((row) => row.includes(CURSOR_MARKER)));
			editor.handleInput("\x1b[C");
			assert.deepEqual(editor.getCursor(), { line: 0, col: 1 + grapheme.length });
			editor.render(1);
			assert.equal(editor.getText(), `a${grapheme}b`);
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.handleInput("\r");
			assert.equal(submitted, `a${grapheme}b`);
		});
	}
});

describe("image attachment undo", () => {
	for (const deletion of ["backspace", "forward", "clear"]) {
		it(`restores attachment identity after ${deletion} and submits it`, () => {
			const editor = createEditor();
			editor.insertImageMarker({ path: "/inert/one.png", mimeType: "image/png" });
			const original = editor.getPendingImages();
			if (deletion === "forward") editor.handleInput("\x01");
			if (deletion === "clear") editor.setText("");
			else editor.handleInput(deletion === "backspace" ? "\x7f" : "\x1b[3~");
			assert.deepEqual(editor.getPendingImages(), []);
			editor.handleInput("\x1f");
			assert.equal(editor.getText(), "[image_1]");
			assert.deepEqual(editor.getPendingImages(), original);
			assert.equal(editor.getPendingImages()[0], original[0]);
			editor.handleInput("\r");
			assert.deepEqual(editor.takePendingImages(), original);
			assert.deepEqual(editor.takePendingImages(), []);
		});
	}

	it("keeps IDs distinct across undo and further insertion", () => {
		const editor = createEditor();
		editor.insertImageMarker({ path: "/inert/one.png", mimeType: "image/png" });
		editor.insertImageMarker({ path: "/inert/two.png", mimeType: "image/png" });
		editor.handleInput("\x1f");
		const nextId = editor.insertImageMarker({ path: "/inert/three.png", mimeType: "image/png" });
		assert.equal(nextId, 3);
		assert.deepEqual(
			editor.getPendingImages().map(({ id }) => id),
			[1, 3],
		);
		editor.handleInput("\x7f");
		editor.handleInput("\x1f");
		assert.deepEqual(
			editor.getPendingImages().map(({ id }) => id),
			[1, 3],
		);
	});
});

const plain = (text: string) => text;
const theme: SettingsListTheme = {
	label: plain,
	value: plain,
	description: plain,
	disabled: plain,
	cursor: "> ",
	hint: plain,
};

describe("settings search focus", () => {
	it("focuses inputs inside container submenus, including input replacement", () => {
		const first = new Input();
		const second = new Input();
		const submenu = new Container();
		submenu.addChild(first);
		const parent = new SettingsList(
			[
				{
					id: "input",
					label: "Input",
					currentValue: "",
					submenu: () => submenu,
				},
			],
			5,
			theme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		parent.focused = true;
		parent.handleInput("\r");
		assert.ok(parent.render(40).join("").includes(CURSOR_MARKER));
		assert.equal(first.focused, true);
		submenu.clear();
		submenu.addChild(second);
		parent.render(40);
		assert.equal(first.focused, false);
		assert.equal(second.focused, true);
		parent.focused = false;
		assert.equal(second.focused, false);
	});

	it("moves IME focus into submenus and restores it on close", () => {
		const tui = new TUI(new VirtualTerminal());
		let child: SettingsList | undefined;
		const parent = new SettingsList(
			[
				{
					id: "submenu",
					label: "Submenu",
					currentValue: "",
					submenu: (_value, done) => {
						child = new SettingsList(
							[],
							5,
							theme,
							() => {},
							() => done(),
							{ enableSearch: true },
						);
						return child;
					},
				},
			],
			5,
			theme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		tui.setFocus(parent);
		assert.ok(parent.render(40).join("").includes(CURSOR_MARKER));
		parent.handleInput("\r");
		assert.ok(child?.render(40).join("").includes(CURSOR_MARKER));
		tui.setFocus(null);
		assert.ok(!child?.render(40).join("").includes(CURSOR_MARKER));
		tui.setFocus(parent);
		parent.handleInput("\x1b");
		assert.ok(!child?.render(40).join("").includes(CURSOR_MARKER));
		assert.ok(parent.render(40).join("").includes(CURSOR_MARKER));
		tui.setFocus(null);
		assert.ok(!parent.render(40).join("").includes(CURSOR_MARKER));
	});
});
