import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { TUI } from "../src/tui.ts";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "../src/utils.ts";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC52 = "\x1b]52;c;SGVsbG8=\x07";

describe("terminal control sanitization", () => {
	it("removes C0, C1, CSI, OSC, DCS, and APC controls from untrusted text", () => {
		const input = `a\x00b\x80c\x1b[2Jd${OSC52}e\x1bPpayload\x1b\\f\x1b_payload\x07g\n\th`;
		const safe = sanitizeTerminalText(input);
		assert.strictEqual(safe, "abcdefg\n\th");
		assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(safe));
	});

	it("sanitizes bracketed paste before editor storage and rendering", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.handleInput(`\x1b[200~safe${OSC52}\x1b[201~`);
		assert.strictEqual(editor.getText(), "safe");
		assert.ok(editor.render(80).every((line) => !line.includes("\x1b]52") && !line.includes("\x07")));
	});

	it("strips private CSI sequences such as ESC[>4;2m", () => {
		const safe = sanitizeTerminalOutput(`ok\x1b[>4;2mnope\x1b[31mred\x1b[0m`);
		assert.strictEqual(safe, "oknope\x1b[31mred\x1b[0m");
		assert.ok(!safe.includes("\x1b[>"));
	});

	it("keeps trusted SGR styling while stripping controls from text and markdown", () => {
		const styled = new Text(`\x1b[31mred\x1b[0m${OSC52}`, 0, 0).render(20).join("\n");
		assert.ok(styled.includes("\x1b[31mred\x1b[0m"));
		assert.ok(!styled.includes("\x1b]52"));

		const markdown = new Markdown(`safe${OSC52}`, 0, 0, defaultMarkdownTheme).render(20).join("\n");
		assert.ok(markdown.includes("safe"));
		assert.ok(!markdown.includes("\x1b]52"));
	});
});
