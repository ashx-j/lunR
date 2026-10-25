import { describe, expect, it } from "vitest";
import { describeProviderError } from "../src/core/provider-error-display.ts";

describe("describeProviderError", () => {
	it("replaces a JSON body with its message and keeps the status and prefix", () => {
		expect(
			describeProviderError('401: {"error":{"message":"Incorrect API key provided: bad"}}', "openai", "interactive"),
		).toEqual({
			summary: "401: Incorrect API key provided: bad",
			status: 401,
			hint: "openai rejected the key or login. Run /login openai to fix it.",
		});
		expect(describeProviderError('OpenAI API error (429): {"message":"Slow down"}', "openai", "interactive")).toEqual(
			{ summary: "OpenAI API error (429): Slow down", status: 429, hint: undefined },
		);
	});

	it("falls back to an error type and words the hint for print mode", () => {
		const result = describeProviderError('403 {"type":"FreeTierError"}', "opencode", "print");
		expect(result.summary).toBe("403: FreeTierError");
		expect(result.hint).toBe("opencode rejected the key or login. Run lunr, then /login, or set the env key.");
	});

	it("leaves text without a JSON body unchanged", () => {
		expect(describeProviderError("socket hang up", "openai", "interactive")).toEqual({
			summary: "socket hang up",
			status: undefined,
			hint: undefined,
		});
	});
});
