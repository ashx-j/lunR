import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("does not include /token-usage", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "token-usage")).toBe(false);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "usage")).toBe(true);
	});

	it("registers Codex Fast mode and removes deep research", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "fast")).toBe(true);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "research")).toBe(false);
	});

	it("includes a terminal-independent image paste command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "paste-image")).toBe(true);
	});

	it("includes /edit and describes /undo as same-session rewind", () => {
		const edit = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "edit");
		const undo = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "undo");
		expect(edit?.description).toContain("chat box");
		expect(undo?.description).toContain("same session");
		expect(undo?.description).toContain("/redo");
	});
});
