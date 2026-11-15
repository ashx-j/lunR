import assert from "node:assert";
import { describe, it } from "node:test";
import { findChatAnchor } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

// The straightforward scan findChatAnchor replaced: every copy via indexOf, longest run wins, then
// the copy closest to `start`, then the earlier one. The fast version must pick the same anchor.
function referenceAnchor(previous: string[], next: string[], start: number, viewH: number): number | undefined {
	for (let offset = 0; offset < Math.min(4, viewH, previous.length - start); offset++) {
		const line = previous[start + offset];
		if (!line || visibleWidth(line) === 0) continue;
		const following = previous[start + offset + 1];
		let best: number | undefined;
		let bestScore = 0;
		for (let match = next.indexOf(line); match !== -1; match = next.indexOf(line, match + 1)) {
			if (following !== undefined && next[match + 1] !== following) continue;
			const candidate = match - offset;
			if (candidate < 0) continue;
			let score = 1;
			while (
				score < 12 &&
				start + offset + score < previous.length &&
				previous[start + offset + score] === next[match + score]
			)
				score++;
			if (
				score > bestScore ||
				(score === bestScore && (best === undefined || Math.abs(candidate - start) < Math.abs(best - start)))
			) {
				best = candidate;
				bestScore = score;
			}
		}
		if (best !== undefined) return best;
	}
	return undefined;
}

// Small seeded PRNG so failures reproduce.
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const repeated = (count: number, line = "│ ──── │") => Array.from({ length: count }, () => line);

describe("findChatAnchor", () => {
	it("keeps the same row in a run of identical rows when output is appended", () => {
		const previous = repeated(200);
		const next = [...previous, "new tail"];
		assert.strictEqual(findChatAnchor(previous, next, 120, 10), 120);
	});

	it("follows distinct earlier output that pushes repeated rows down", () => {
		const previous = ["head", ...repeated(30), "tail A", "tail B"];
		const next = ["inserted 1", "inserted 2", ...previous];
		// The view starts near the end of the run, so the run plus the tail only matches the shifted copy.
		assert.strictEqual(findChatAnchor(previous, next, 25, 10), 27);
	});

	it("prefers a longer matching run over a nearer copy", () => {
		const previous = ["x", "A", "B", "C", "D"];
		const next = ["A", "B", "q", "q", "q", "A", "B", "C", "D"];
		assert.strictEqual(findChatAnchor(previous, next, 1, 5), 5);
	});

	it("breaks a tie at equal distance toward the earlier copy", () => {
		const previous = ["x", "A", "B"];
		const next = ["A", "B", "A", "B"];
		assert.strictEqual(findChatAnchor(previous, next, 1, 5), 0);
	});

	it("skips blank visible lines and never anchors above the top", () => {
		const previous = ["", "A", "B"];
		assert.strictEqual(findChatAnchor(previous, ["A", "B", "z", "A", "B"], 0, 5), 2);
		assert.strictEqual(findChatAnchor(previous, ["A", "B"], 0, 5), undefined);
	});

	it("returns undefined after a width reflow changes every line", () => {
		const previous = repeated(100, "│ ──── │");
		const next = repeated(120, "│ ─── │");
		assert.strictEqual(findChatAnchor(previous, next, 40, 10), undefined);
	});

	it("matches the reference scan on random repetitive layouts", () => {
		const random = rng(0xc0ffee);
		const alphabet = ["A", "B", "│ ── │", ""];
		const pick = () => alphabet[Math.floor(random() * alphabet.length)] ?? "A";
		for (let i = 0; i < 3000; i++) {
			const previous = Array.from({ length: 1 + Math.floor(random() * 40) }, pick);
			const next = previous.slice();
			for (let edits = Math.floor(random() * 4); edits > 0; edits--) {
				const at = Math.floor(random() * (next.length + 1));
				if (random() < 0.6) next.splice(at, 0, ...Array.from({ length: 1 + Math.floor(random() * 3) }, pick));
				else next.splice(at, 1 + Math.floor(random() * 3));
			}
			const start = Math.floor(random() * previous.length);
			const viewH = 1 + Math.floor(random() * 6);
			assert.strictEqual(
				findChatAnchor(previous, next, start, viewH),
				referenceAnchor(previous, next, start, viewH),
				JSON.stringify({ previous, next, start, viewH }),
			);
		}
	});
});
