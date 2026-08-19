import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("does not include /token-usage", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "token-usage")).toBe(false);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "usage")).toBe(true);
	});
});
