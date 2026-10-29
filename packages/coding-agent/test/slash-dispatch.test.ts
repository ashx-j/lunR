import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	findArgumentlessSlashCommand,
	findSlashCommandHandler,
	runSlashCommand,
	SLASH_COMMAND_HANDLERS,
	type SlashCommandHost,
} from "../src/modes/interactive/slash-dispatch.ts";

// Builtins the submit handler runs itself, before its detached-session guard.
const HANDLED_BEFORE_DISPATCH = ["reclaim"];

describe("slash dispatch", () => {
	it("has a handler for every builtin table entry and nothing outside the table", () => {
		const tableNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect([...SLASH_COMMAND_HANDLERS.keys(), ...HANDLED_BEFORE_DISPATCH].sort()).toEqual(tableNames.sort());
	});

	it("matches the name before the first whitespace and passes arguments only to handlers that take them", () => {
		expect(findSlashCommandHandler("/model")).toBe(SLASH_COMMAND_HANDLERS.get("model"));
		expect(findSlashCommandHandler("/model sonnet")).toBe(SLASH_COMMAND_HANDLERS.get("model"));
		expect(findSlashCommandHandler("/model\tsonnet")).toBe(SLASH_COMMAND_HANDLERS.get("model"));
		expect(findSlashCommandHandler("/plan\nfix the bug")).toBe(SLASH_COMMAND_HANDLERS.get("plan"));
		expect(findSlashCommandHandler("/auth anthropic")).toBe(SLASH_COMMAND_HANDLERS.get("login"));
		for (const text of ["/modelx", "/settings extra", "/exit now", "/new\nfix the bug", "model", "/"]) {
			expect(findSlashCommandHandler(text)).toBeUndefined();
		}
	});

	it("hands handlers a single space after the name, so a newline-separated task reaches /plan", async () => {
		let planArgs: string | undefined;
		const host = {
			editor: { setText: () => {} },
			handlePlanCommand: async (args: string) => {
				planArgs = args;
			},
		};
		expect(await runSlashCommand(host as unknown as SlashCommandHost, "/plan\nfix the bug\nand test it")).toBe(true);
		expect(planArgs).toBe("fix the bug\nand test it");
		expect(await runSlashCommand(host as unknown as SlashCommandHost, "/nope")).toBe(false);
	});

	it("names a builtin that takes no arguments when text follows it", () => {
		expect(findArgumentlessSlashCommand("/new fix the bug")).toBe("new");
		expect(findArgumentlessSlashCommand("/resume\nx")).toBe("resume");
		for (const text of ["/new", "/new  \n", "/plan fix it", "/model sonnet", " /new fix", "/unknown x", "hello"]) {
			expect(findArgumentlessSlashCommand(text)).toBeUndefined();
		}
	});
});
