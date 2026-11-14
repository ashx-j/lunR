import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	compactionSettingsForWindow,
	compactionThreshold,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

// Alternating user/assistant messages of roughly 500 estimated tokens each.
function sessionEntries(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (let i = 0; i < count; i++) {
		const text = `turn ${i} ${"word ".repeat(400)}`;
		const message: AgentMessage =
			i % 2 === 0
				? { role: "user", content: text, timestamp: i }
				: {
						role: "assistant",
						content: [{ type: "text", text }],
						api: "openai-completions",
						provider: "local",
						model: "small",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: i,
					};
		const id = `entry-${i}`;
		entries.push({ type: "message", id, parentId, timestamp: new Date(i).toISOString(), message });
		parentId = id;
	}
	return entries;
}

describe("compaction settings scale to small context windows", () => {
	it("8k window: reserves 25% and keeps 40%, so a half-full context does not compact", () => {
		expect(compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, 8192)).toMatchObject({
			reserveTokens: 2048,
			keepRecentTokens: 3276,
		});
		expect(shouldCompact(4000, 8192, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(6500, 8192, DEFAULT_COMPACTION_SETTINGS)).toBe(true);

		// About 6k tokens: the unscaled 20k keep-recent budget would keep everything.
		expect(prepareCompaction(sessionEntries(12), DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
		const preparation = prepareCompaction(sessionEntries(12), DEFAULT_COMPACTION_SETTINGS, 8192);
		expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0);
		expect(preparation?.settings.reserveTokens).toBe(2048);
	});

	it("16k window: the 16384 default reserve no longer equals the whole window", () => {
		expect(compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, 16384)).toMatchObject({
			reserveTokens: 4096,
			keepRecentTokens: 6553,
		});
		expect(shouldCompact(10000, 16384, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(12500, 16384, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
		// About 12k tokens.
		const preparation = prepareCompaction(sessionEntries(24), DEFAULT_COMPACTION_SETTINGS, 16384);
		expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0);
	});

	it("200k window: configured values stay unchanged", () => {
		expect(compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, 200_000)).toEqual(DEFAULT_COMPACTION_SETTINGS);
		expect(shouldCompact(200_000 - 16384, 200_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(200_000 - 16383, 200_000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
		// About 12k tokens sit inside the 20k keep-recent budget, so there is nothing to summarize.
		expect(prepareCompaction(sessionEntries(24), DEFAULT_COMPACTION_SETTINGS, 200_000)).toBeUndefined();
	});
});

describe("compaction ceiling", () => {
	const withCeiling = (ceilingTokens: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, ceilingTokens });

	it("compacts a 1M window at the ceiling instead of near the window", () => {
		expect(shouldCompact(300_001, 1_000_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(300_000, 1_000_000, withCeiling(300_000))).toBe(false);
		expect(shouldCompact(300_001, 1_000_000, withCeiling(300_000))).toBe(true);
	});

	it("never raises the threshold above the window's own", () => {
		expect(compactionThreshold(200_000, withCeiling(500_000))).toBe(200_000 - 16384);
	});

	it("raises a ceiling below a freshly compacted context so it cannot compact every turn", () => {
		// 30k of system prompt and tools, plus 20k kept and the 16k reserve for the summary.
		const prefixTokens = 30_000;
		const compactedSize = prefixTokens + 20_000 + 16384;
		expect(compactionThreshold(1_000_000, withCeiling(10_000), prefixTokens)).toBe(compactedSize);
		expect(shouldCompact(compactedSize - 1, 1_000_000, withCeiling(10_000), prefixTokens)).toBe(false);
	});
});
