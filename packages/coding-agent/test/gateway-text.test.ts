import { describe, expect, it } from "vitest";
import { splitMessage, utf16Len } from "../src/gateway/text.ts";

const INDICATOR_RE = / \(\d+\/\d+\)$/;

describe("utf16Len", () => {
	it("counts UTF-16 code units (surrogate pairs count as 2)", () => {
		expect(utf16Len("abc")).toBe(3);
		expect(utf16Len("🙂")).toBe(2);
	});
});

describe("splitMessage", () => {
	it("returns the text untouched when it fits", () => {
		expect(splitMessage("hello", 100)).toEqual(["hello"]);
	});

	it("exact-limit text is a single chunk with no indicator", () => {
		const text = "x".repeat(50);
		expect(splitMessage(text, 50)).toEqual([text]);
	});

	it("prefers blank-line boundaries and appends (n/m) indicators", () => {
		const text = "aaaa\n\nbbbb\n\ncccc";
		const chunks = splitMessage(text, 12);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toBe("aaaa (1/3)");
		expect(chunks[1]).toBe("bbbb (2/3)");
		expect(chunks[2]).toBe("cccc (3/3)");
	});

	it("falls back to line boundaries", () => {
		const chunks = splitMessage("line one\nline two\nline three", 20);
		expect(chunks.length).toBe(3);
		expect(chunks[0].startsWith("line one")).toBe(true);
		expect(chunks[1].startsWith("line two")).toBe(true);
		expect(chunks[2].startsWith("line three")).toBe(true);
	});

	it("every decorated chunk fits the limit", () => {
		const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"y".repeat(20)}`).join("\n\n");
		for (const max of [40, 64, 100]) {
			for (const chunk of splitMessage(text, max)) {
				expect(chunk.length).toBeLessThanOrEqual(max);
			}
		}
	});

	it("closes an unclosed fence at the boundary and reopens it with the language tag", () => {
		const code = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const text = `intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\noutro`;
		const chunks = splitMessage(text, 80);
		expect(chunks.length).toBeGreaterThan(1);
		// Find the chunk that opens the fence: a later chunk must close it, and
		// the next chunk must reopen with the same language tag.
		for (let i = 0; i < chunks.length; i++) {
			const body = chunks[i].replace(INDICATOR_RE, "");
			const fenceLines = body.split("\n").filter((l) => l.trim().startsWith("```"));
			// Every chunk's fences must be balanced.
			expect(fenceLines.length % 2).toBe(0);
			if (body.endsWith("```") && i + 1 < chunks.length) {
				const nextBody = chunks[i + 1].replace(INDICATOR_RE, "");
				expect(nextBody.startsWith("```ts")).toBe(true);
			}
		}
		// Reassembled content still contains the language tag and all lines.
		expect(chunks.join("\n")).toContain("```ts");
		expect(chunks.join("\n")).toContain("outro");
	});

	it("never leaves a dangling fence even with a hard split inside code", () => {
		const code = "x".repeat(200);
		const text = `\`\`\`js\n${code}\n\`\`\``;
		const chunks = splitMessage(text, 60);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const body = chunk.replace(INDICATOR_RE, "");
			const fences = body.split("\n").filter((l) => l.trim().startsWith("```"));
			expect(fences.length % 2).toBe(0);
		}
	});

	it("never splits between surrogate halves", () => {
		// 8 BMP chars + many emoji (2 code units each), no boundaries → hard splits.
		const text = `abcdefgh${"🙂".repeat(30)}`;
		const chunks = splitMessage(text, 25);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const body = chunk.replace(INDICATOR_RE, "");
			const last = body.charCodeAt(body.length - 1);
			const first = body.charCodeAt(0);
			// No trailing lone high surrogate, no leading lone low surrogate.
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
			expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
		}
		// Round-trip: all emoji survive.
		expect(chunks.map((c) => c.replace(INDICATOR_RE, "")).join("")).toBe(text);
	});

	it("word boundary: prefers splitting at spaces", () => {
		const chunks = splitMessage("aaa bbb ccc ddd", 14);
		expect(chunks.length).toBe(2);
		expect(chunks[0].replace(INDICATOR_RE, "")).toBe("aaa bbb");
	});

	it("throws on a non-positive limit", () => {
		expect(() => splitMessage("hello", 0)).toThrow(RangeError);
	});
});
