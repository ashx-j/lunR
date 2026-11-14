import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../src/utils/sanitize-terminal-text.ts";

describe("untrusted terminal text", () => {
	it("preserves Unicode, Markdown, tabs and logical newlines", () => {
		const source = "**界** 🙂 👨‍👩‍👧‍👦 é\tvalue\n[link](https://example.com/)";
		expect(sanitizeTerminalText(source) === source).toBe(true);
		expect(sanitizeTerminalText("a\r\nb\rc") === "a\nb\nc").toBe(true);
	});

	it("removes 7-bit and 8-bit control sequences while retaining surrounding text", () => {
		const controls = [
			"\x1b[31m",
			"\x1b[?25l",
			"\x1b[1;2H",
			"\x9b2J",
			"\x1bc",
			"\x1b(0",
			"\x1b]52;c;inert\x07",
			"\x1b]0;title\x1b\\",
			"\x9d0;title\x9c",
			"\x1bPdata\x1b\\",
			"\x90data\x9c",
			"\x1bXdata\x1b\\",
			"\x98data\x9c",
			"\x1b^data\x1b\\",
			"\x9edata\x9c",
			"\x1b_Gdata\x1b\\",
			"\x9fdata\x9c",
			"\x00",
			"\x07",
			"\x08",
			"\x0b",
			"\x0c",
			"\x7f",
			"\x85",
		];
		for (const control of controls) {
			expect(sanitizeTerminalText(`before${control}after`) === "beforeafter").toBe(true);
		}
	});

	it("drops incomplete CSI and opaque string prefixes without emitting an introducer", () => {
		for (const control of ["\x1b", "\x1b[", "\x1b[123;", "\x9b123;", "\x1b]52;c;inert", "\x1bPdata", "\x1b_Gdata"]) {
			expect(sanitizeTerminalText(`before${control}`) === "before").toBe(true);
		}
	});

	it("never leaves controls in malformed or nested sequences", () => {
		const fragments = ["\x1b[\n", "\x1b\n", "\x1b\x1b[2J", "\x1b]bad\x1b[2J", "\x1bP\x07\x1b\\"];
		for (const fragment of fragments) {
			const result = sanitizeTerminalText(`before${fragment}after`);
			expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(result)).toBe(false);
		}
	});
});
