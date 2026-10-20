import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { findSlashCommandHandler, SLASH_COMMAND_HANDLERS } from "../src/modes/interactive/slash-dispatch.ts";

// Builtins the submit handler runs itself, before its detached-session guard.
const HANDLED_BEFORE_DISPATCH = ["handoff", "reclaim"];

describe("slash dispatch", () => {
	it("has a handler for every builtin table entry and nothing outside the table", () => {
		const tableNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect([...SLASH_COMMAND_HANDLERS.keys(), ...HANDLED_BEFORE_DISPATCH].sort()).toEqual(tableNames.sort());
	});

	it("matches the name before the first space and passes arguments only to handlers that take them", () => {
		expect(findSlashCommandHandler("/model")).toBe(SLASH_COMMAND_HANDLERS.get("model"));
		expect(findSlashCommandHandler("/model sonnet")).toBe(SLASH_COMMAND_HANDLERS.get("model"));
		expect(findSlashCommandHandler("/auth anthropic")).toBe(SLASH_COMMAND_HANDLERS.get("login"));
		for (const text of ["/modelx", "/settings extra", "/exit now", "/model\tsonnet", "model", "/"]) {
			expect(findSlashCommandHandler(text)).toBeUndefined();
		}
	});
});
