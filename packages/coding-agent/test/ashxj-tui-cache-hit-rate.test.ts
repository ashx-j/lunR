import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStatsLine } from "../src/builtin-extensions/ashxj-tui.ts";

const CUSTOMIZE_SYMBOL = Symbol.for("@lunr/customize");
let previousBridge: unknown;

function renderCacheHitRate(entries: unknown[], width = 120): string {
	return renderStatsLine(
		width,
		{
			model: undefined,
			sessionManager: { getEntries: () => entries },
			getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		} as Parameters<typeof renderStatsLine>[1],
		{ fg: (_token, text) => text } as Parameters<typeof renderStatsLine>[2],
		{
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
		} as Parameters<typeof renderStatsLine>[3],
	).join("\n");
}

describe("ashxj-tui cache hit rate", () => {
	beforeEach(() => {
		previousBridge = (globalThis as Record<symbol, unknown>)[CUSTOMIZE_SYMBOL];
	});

	afterEach(() => {
		if (previousBridge === undefined) delete (globalThis as Record<symbol, unknown>)[CUSTOMIZE_SYMBOL];
		else (globalThis as Record<symbol, unknown>)[CUSTOMIZE_SYMBOL] = previousBridge;
	});

	it("shows the latest assistant request's cache-read share", () => {
		const footer = renderCacheHitRate([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 50, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 10, cacheRead: 25, cacheWrite: 25, cost: { total: 0 } },
				},
			},
		]);

		expect(footer).toContain("cache 16.7%");
	});

	it("falls back to the short CH label when the labeled line does not fit", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 10, cacheRead: 25, cacheWrite: 25, cost: { total: 0 } },
				},
			},
		];
		// "12%/200k | ↑100 ↓10 | CH16.7%" is 30 columns; the labeled form is 34.
		expect(renderCacheHitRate(entries, 34)).toContain("cache 16.7%");
		expect(renderCacheHitRate(entries, 30)).toContain("CH16.7%");
	});

	it("hides the rate when cache usage is unavailable", () => {
		const footer = renderCacheHitRate([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			},
		]);

		expect(footer).not.toMatch(/cache|CH/);
	});

	it("hides the rate when the footer setting is disabled", () => {
		(globalThis as Record<symbol, unknown>)[CUSTOMIZE_SYMBOL] = { getFooterCacheHitRate: () => false };
		const footer = renderCacheHitRate([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } },
				},
			},
		]);

		expect(footer).not.toMatch(/cache|CH/);
	});
});
