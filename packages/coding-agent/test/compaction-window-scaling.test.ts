import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	compactionSettingsForWindow,
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
