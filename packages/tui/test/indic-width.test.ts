import assert from "node:assert";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

// Expected values match glibc wcswidth (and xterm, VTE, xterm.js): one cell per code point except
// nonspacing marks and format characters. Grapheme-mode terminals such as kitty draw fewer cells, so
// these widths are the upper bound and a measured line never overflows.
describe("Indic grapheme width", () => {
	it("counts each consonant of a virama conjunct", () => {
		assert.strictEqual(visibleWidth("क्ष"), 2);
		assert.strictEqual(visibleWidth("न्द्र"), 3);
		assert.strictEqual(visibleWidth("ক্ষ"), 2);
		// ZWJ after the virama is zero width.
		assert.strictEqual(visibleWidth("क्‍ष"), 2);
	});

	it("counts spacing vowel signs but not nonspacing ones", () => {
		assert.strictEqual(visibleWidth("का"), 2); // U+093E is Mc
		assert.strictEqual(visibleWidth("के"), 1); // U+0947 is Mn
		assert.strictEqual(visibleWidth("हिन्दी"), 5);
		assert.strictEqual(visibleWidth("नमस्ते"), 4);
		assert.strictEqual(visibleWidth("தமிழ்"), 4);
	});

	it("wraps and truncates Hindi without exceeding the width", () => {
		const text = "हिन्दी नमस्ते संस्कृतम् क्षत्रिय";
		for (const line of wrapTextWithAnsi(text, 8)) {
			assert.ok(visibleWidth(line) <= 8, JSON.stringify(line));
		}
		assert.ok(visibleWidth(truncateToWidth(text, 7)) <= 7);
	});

	it("leaves Latin combining marks at one cell", () => {
		assert.strictEqual(visibleWidth("é"), 1);
	});
});
