import { describe, expect, it } from "vitest";
import {
	findUnknownSlashCommand,
	formatUnknownSlashCommandStatus,
	INTERACTIVE_BUILTIN_COMMAND_NAMES,
	suggestSlashCommands,
} from "../src/modes/interactive/slash-guidance.ts";

// Stands in for dispatch: builtins plus one extension command and one prompt template.
const isKnown = (name: string) => INTERACTIVE_BUILTIN_COMMAND_NAMES.has(name) || name === "run" || name === "review";

describe("findUnknownSlashCommand", () => {
	it("flags a command-shaped first token that nothing dispatches", () => {
		expect(findUnknownSlashCommand("/modle", isKnown)).toBe("modle");
		expect(findUnknownSlashCommand("/does-not-exist with args", isKnown)).toBe("does-not-exist");
		expect(findUnknownSlashCommand("/foo\nsecond line", isKnown)).toBe("foo");
	});

	it("leaves dispatchable commands alone, including ones only the submit chain handles", () => {
		for (const text of ["/model", "/settings extra", "/debug", "/help", "/run task", "/review"]) {
			expect(findUnknownSlashCommand(text, isKnown)).toBeUndefined();
		}
	});

	it("sends a leading space, paths, a bare slash and non-command tokens through as messages", () => {
		for (const text of [
			" /modle",
			"\t/modle",
			"/usr/bin/env",
			"/etc/hosts is broken",
			"/notes.md",
			"/",
			"/ hello",
			"/skill:missing",
			"/foo:2",
			"/Foo",
			"/1password",
			"hello /modle",
		]) {
			expect(findUnknownSlashCommand(text, isKnown)).toBeUndefined();
		}
	});
});

describe("unknown command status", () => {
	it("suggests up to two commands with the picker's fuzzy matcher", () => {
		const candidates = ["model", "mode", "settings", "scoped-models", "model"];
		const suggestions = suggestSlashCommands("mod", candidates);
		expect(suggestions).toHaveLength(2);
		expect(suggestions).toEqual(expect.arrayContaining(["mode", "model"]));
		expect(suggestSlashCommands("zzz", candidates)).toEqual([]);
	});

	it("formats the status line with and without suggestions", () => {
		expect(formatUnknownSlashCommandStatus("x", ["y", "z"])).toBe(
			"Unknown command /x. Did you mean /y or /z? Start with a space to send it as a message.",
		);
		expect(formatUnknownSlashCommandStatus("x", [])).toBe(
			"Unknown command /x. Start with a space to send it as a message.",
		);
	});
});
