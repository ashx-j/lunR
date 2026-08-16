import assert from "node:assert";
import { describe, it } from "node:test";
import { parseMouseEvent } from "../src/mouse.ts";

describe("parseMouseEvent", () => {
	it("parses SGR wheel up", () => {
		const ev = parseMouseEvent("\x1b[<64;10;5M");
		assert.ok(ev);
		assert.strictEqual(ev.kind, "wheel");
		assert.strictEqual(ev.delta, 1);
		assert.strictEqual(ev.button, 64);
		assert.strictEqual(ev.x, 10);
		assert.strictEqual(ev.y, 5);
		assert.strictEqual(ev.ctrl, false);
		assert.strictEqual(ev.shift, false);
		assert.strictEqual(ev.release, false);
	});

	it("parses SGR wheel down", () => {
		const ev = parseMouseEvent("\x1b[<65;1;1M");
		assert.ok(ev);
		assert.strictEqual(ev.kind, "wheel");
		assert.strictEqual(ev.delta, -1);
		assert.strictEqual(ev.button, 65);
	});

	it("parses SGR wheel with ctrl / shift / alt", () => {
		const ctrl = parseMouseEvent("\x1b[<80;2;3M");
		assert.ok(ctrl);
		assert.strictEqual(ctrl.kind, "wheel");
		assert.strictEqual(ctrl.delta, 1);
		assert.strictEqual(ctrl.ctrl, true);

		const shift = parseMouseEvent("\x1b[<68;2;3M");
		assert.ok(shift);
		assert.strictEqual(shift.kind, "wheel");
		assert.strictEqual(shift.shift, true);
		assert.strictEqual(shift.delta, 1);

		const alt = parseMouseEvent("\x1b[<72;2;3M");
		assert.ok(alt);
		assert.strictEqual(alt.kind, "wheel");
		assert.strictEqual(alt.alt, true);
	});

	it("parses SGR left click press and release", () => {
		const press = parseMouseEvent("\x1b[<0;4;8M");
		assert.ok(press);
		assert.strictEqual(press.kind, "button");
		assert.strictEqual(press.button, 0);
		assert.strictEqual(press.release, false);
		assert.strictEqual(press.delta, 0);

		const release = parseMouseEvent("\x1b[<0;4;8m");
		assert.ok(release);
		assert.strictEqual(release.kind, "button");
		assert.strictEqual(release.release, true);
	});

	it("parses SGR motion", () => {
		const ev = parseMouseEvent("\x1b[<32;6;7M");
		assert.ok(ev);
		assert.strictEqual(ev.kind, "move");
		assert.strictEqual(ev.x, 6);
		assert.strictEqual(ev.y, 7);
	});

	it("parses horizontal wheel as wheel with delta 0", () => {
		const left = parseMouseEvent("\x1b[<66;1;1M");
		assert.ok(left);
		assert.strictEqual(left.kind, "wheel");
		assert.strictEqual(left.delta, 0);
		assert.strictEqual(left.button, 66);
	});

	it("parses X10 wheel up and down", () => {
		const up = parseMouseEvent(
			`\x1b[M${String.fromCharCode(32 + 64)}${String.fromCharCode(32 + 3)}${String.fromCharCode(32 + 4)}`,
		);
		assert.ok(up);
		assert.strictEqual(up.kind, "wheel");
		assert.strictEqual(up.delta, 1);
		assert.strictEqual(up.x, 3);
		assert.strictEqual(up.y, 4);

		const down = parseMouseEvent(
			`\x1b[M${String.fromCharCode(32 + 65)}${String.fromCharCode(33)}${String.fromCharCode(33)}`,
		);
		assert.ok(down);
		assert.strictEqual(down.kind, "wheel");
		assert.strictEqual(down.delta, -1);
		assert.strictEqual(down.x, 1);
		assert.strictEqual(down.y, 1);
	});

	it("rejects non-mouse input", () => {
		assert.strictEqual(parseMouseEvent("a"), undefined);
		assert.strictEqual(parseMouseEvent("\x1b[A"), undefined);
		assert.strictEqual(parseMouseEvent("\x1b[<64;1M"), undefined);
		assert.strictEqual(parseMouseEvent("\x1b[M"), undefined);
		assert.strictEqual(parseMouseEvent(""), undefined);
	});
});
