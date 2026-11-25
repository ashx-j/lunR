import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStatsLine } from "../src/builtin-extensions/ashxj-tui.ts";

const CUSTOMIZE_SYMBOL = Symbol.for("@lunr/customize");
let previousBridge: unknown;

function renderCacheHitRate(
	entries: unknown[],
	width = 120,
	sessionManager: { getEntries: () => unknown[] } = { getEntries: () => entries },
): string {
	return renderStatsLine(
		width,
		{
			model: undefined,
			sessionManager,
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

	it("picks one label per width from the widest line, so growing counts never flip it", () => {
		const usage = (input: number, output: number) => [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input, output, cacheRead: 25, cacheWrite: 25, cost: { total: 0 } },
				},
			},
		];
		(globalThis as Record<symbol, unknown>)[CUSTOMIZE_SYMBOL] = { getFooterTokens: () => true };
		let entries = usage(100, 10);
		const session = { getEntries: () => entries };
		// Widest line: "no model · /login | ↑999k ↓999k | cache 100.0%" is 46 columns.
		expect(renderCacheHitRate(entries, 46, session)).toContain("cache 16.7%");
		expect(renderCacheHitRate(entries, 45, session)).toContain("CH16.7%");
		entries = usage(400_000, 300_000);
		expect(renderCacheHitRate(entries, 46, session)).toContain("↑400k ↓300k | cache 0.0%");
		entries = usage(100, 10);
		expect(renderCacheHitRate(entries, 45, session)).toContain("CH16.7%");
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
