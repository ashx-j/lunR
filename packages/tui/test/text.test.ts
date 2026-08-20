import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

describe("Text padding", () => {
	it("constructor paddingY applies to both top and bottom", () => {
		const text = new Text("hello", 0, 1);
		const lines = text.render(10);
		assert.strictEqual(lines.length, 3);
		assert.strictEqual(lines[0].trim(), "");
		assert.ok(lines[1].includes("hello"));
		assert.strictEqual(lines[2].trim(), "");
	});

	it("setPaddingTop and setPaddingBottom are independent", () => {
		const text = new Text("hello", 0, 1);
		text.setPaddingTop(0);
		text.setPaddingBottom(1);
		const lines = text.render(10);
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].includes("hello"));
		assert.strictEqual(lines[1].trim(), "");
	});

	it("setPadding after render is not served from a stale cache", () => {
		const text = new Text("hello", 0, 1);
		assert.strictEqual(text.render(10).length, 3);
		text.setPaddingTop(0);
		const afterTop = text.render(10);
		assert.strictEqual(afterTop.length, 2);
		assert.ok(afterTop[0].includes("hello"));
	});
});
