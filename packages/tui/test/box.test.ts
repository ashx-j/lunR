import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import type { Component } from "../src/tui.ts";

class Line implements Component {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(_width: number): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

describe("Box padding", () => {
	it("constructor paddingY applies to both top and bottom", () => {
		const box = new Box(1, 1);
		box.addChild(new Line("hello"));
		const lines = box.render(10);

		assert.strictEqual(lines.length, 3);
		assert.strictEqual(lines[0].trim(), "");
		assert.ok(lines[1].includes("hello"));
		assert.strictEqual(lines[2].trim(), "");
	});

	it("setPaddingTop and setPaddingBottom are independent", () => {
		const box = new Box(1, 1);
		box.addChild(new Line("hello"));
		box.setPaddingTop(0);
		box.setPaddingBottom(1);
		const lines = box.render(10);

		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].includes("hello"));
		assert.strictEqual(lines[1].trim(), "");
	});

	it("setPadding after render is not served from a stale cache", () => {
		const box = new Box(1, 1);
		box.addChild(new Line("hello"));
		assert.strictEqual(box.render(10).length, 3);

		box.setPaddingTop(0);
		const afterTop = box.render(10);
		assert.strictEqual(afterTop.length, 2);
		assert.ok(afterTop[0].includes("hello"));

		box.setPadding(1, 0);
		assert.strictEqual(box.render(10).length, 1);
	});
});
