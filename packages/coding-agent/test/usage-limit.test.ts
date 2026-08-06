import { describe, expect, test } from "vitest";
import { isAuthInvalidError, isUsageLimitError, parseResetTimeMs } from "../src/core/usage-limit.ts";

describe("isUsageLimitError", () => {
	test("matches provider quota/billing error bodies", () => {
		expect(isUsageLimitError("Error: insufficient_quota")).toBe(true);
		expect(isUsageLimitError("Monthly usage limit reached")).toBe(true);
		expect(isUsageLimitError("quota exceeded")).toBe(true);
		expect(isUsageLimitError("You have exceeded your usage limit for this period")).toBe(true);
		expect(isUsageLimitError("insufficient credits remaining")).toBe(true);
		expect(isUsageLimitError("payment required to continue")).toBe(true);
		expect(isUsageLimitError("GoUsageLimitError: weekly cap")).toBe(true);
		expect(isUsageLimitError("FreeUsageLimitError")).toBe(true);
		expect(isUsageLimitError("account is out of budget")).toBe(true);
	});

	test("does not match the retryable rate-limit class", () => {
		expect(isUsageLimitError("429: rate limit exceeded")).toBe(false);
		expect(isUsageLimitError("too many requests")).toBe(false);
		expect(isUsageLimitError("server overloaded, try again")).toBe(false);
	});

	test("returns false for empty or unrelated messages", () => {
		expect(isUsageLimitError("")).toBe(false);
		expect(isUsageLimitError("something unrelated happened")).toBe(false);
	});
});

describe("isAuthInvalidError", () => {
	test("matches 401 / invalid-credential error bodies", () => {
		expect(isAuthInvalidError("401: invalid api key")).toBe(true);
		expect(isAuthInvalidError("Unauthorized")).toBe(true);
		expect(isAuthInvalidError("request is unauthenticated")).toBe(true);
		expect(isAuthInvalidError("authentication failed for token")).toBe(true);
	});

	test("returns false for unrelated messages", () => {
		expect(isAuthInvalidError("")).toBe(false);
		expect(isAuthInvalidError("quota exceeded")).toBe(false);
	});
});

describe("parseResetTimeMs", () => {
	test("parses relative reset times", () => {
		const before = Date.now();
		const parsed = parseResetTimeMs("quota exceeded, reset in 2h");
		const after = Date.now();
		expect(parsed).toBeDefined();
		expect(parsed).toBeGreaterThanOrEqual(before + 2 * 3600_000);
		expect(parsed).toBeLessThanOrEqual(after + 2 * 3600_000);
	});

	test("parses retry-in minutes and available-in seconds", () => {
		const before = Date.now();
		const minutes = parseResetTimeMs("please retry in 30m");
		expect(minutes).toBeGreaterThanOrEqual(before + 30 * 60_000);
		expect(minutes).toBeLessThanOrEqual(Date.now() + 30 * 60_000);

		const seconds = parseResetTimeMs("available in 3600s");
		expect(seconds).toBeGreaterThanOrEqual(before + 3600_000);
		expect(seconds).toBeLessThanOrEqual(Date.now() + 3600_000);
	});

	test("parses ISO-8601 timestamps in the future", () => {
		const future = new Date(Date.now() + 3600_000).toISOString();
		const parsed = parseResetTimeMs(`quota resets at ${future}`);
		expect(parsed).toBe(Date.parse(future));
	});

	test("returns undefined for garbage or past timestamps", () => {
		expect(parseResetTimeMs("no timing information here")).toBeUndefined();
		expect(parseResetTimeMs("")).toBeUndefined();
		expect(parseResetTimeMs("reset at 2001-01-01T00:00:00Z")).toBeUndefined();
	});
});
