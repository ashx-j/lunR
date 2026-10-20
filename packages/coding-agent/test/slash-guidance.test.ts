import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	findUnknownSlashCommand,
	formatUnknownSlashCommandStatus,
	INTERACTIVE_BUILTIN_COMMAND_NAMES,
	suggestSlashCommands,
} from "../src/modes/interactive/slash-guidance.ts";

// Stands in for dispatch: builtins plus one extension command and one prompt template.
const isKnown = (name: string) => INTERACTIVE_BUILTIN_COMMAND_NAMES.has(name) || name === "run" || name === "review";
// Session cwd with one directory in it, so `/scratch` names a path relative to the project.
const cwd = mkdtempSync(join(tmpdir(), "slash-guidance-"));
mkdirSync(join(cwd, "scratch"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("findUnknownSlashCommand", () => {
	it("flags a command-shaped first token that nothing dispatches", () => {
		expect(findUnknownSlashCommand("/modle", isKnown, cwd)).toBe("modle");
		expect(findUnknownSlashCommand("/does-not-exist with args", isKnown, cwd)).toBe("does-not-exist");
		expect(findUnknownSlashCommand("/foo\nsecond line", isKnown, cwd)).toBe("foo");
	});

	it("leaves dispatchable commands alone, including ones only the submit chain handles", () => {
		for (const text of ["/model", "/settings extra", "/debug", "/help", "/run task", "/review"]) {
			expect(findUnknownSlashCommand(text, isKnown, cwd)).toBeUndefined();
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
			expect(findUnknownSlashCommand(text, isKnown, cwd)).toBeUndefined();
		}
	});

	it("treats a single-segment token that exists on disk as a path", () => {
		expect(findUnknownSlashCommand("/scratch is full, clean it up", isKnown, cwd)).toBeUndefined();
		expect(findUnknownSlashCommand("/scratchy", isKnown, cwd)).toBe("scratchy");
	});

	it.skipIf(process.platform === "win32")("treats a root directory such as /tmp as a path", () => {
		expect(findUnknownSlashCommand("/tmp is full, clean it up", isKnown, cwd)).toBeUndefined();
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

	it("falls back to edit distance for typos the fuzzy matcher misses", () => {
		const candidates = ["model", "mode", "help", "hotkeys", "settings", "new"];
		expect(suggestSlashCommands("modle", candidates)).toEqual(["model", "mode"]);
		expect(suggestSlashCommands("hepl", candidates)).toEqual(["help"]);
		expect(suggestSlashCommands("settigns", candidates)).toEqual(["settings"]);
		expect(suggestSlashCommands("zzq", candidates)).toEqual([]);
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
