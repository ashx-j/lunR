import assert from "node:assert";
import { describe, it } from "node:test";
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE, parseMouseEvent } from "../src/mouse.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

	it("enable/disable sequences include button-motion (1002)", () => {
		assert.ok(MOUSE_TRACKING_ENABLE.includes("?1002h"));
		assert.ok(MOUSE_TRACKING_DISABLE.includes("?1002l"));
	});
});

class SelectableLines implements Component {
	selectable = true;
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class StaticLines implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("in-app message selection", () => {
	it("press+drag+release over a selectable child does not copy", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const selected: string[] = [];
		tui.onTextSelected = (text) => selected.push(text);
		tui.addChild(new SelectableLines(["hello", "world", "again"]));
		tui.addChild(new StaticLines(["DOCK"]));
		tui.pinFrom(tui.children[1]!);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;1;2M");
		terminal.sendInput("\x1b[<0;1;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(selected, []);
		tui.stop();
	});

	it("press+release on a handleClick child toggles it", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		let clicks = 0;
		const clickable: Component = {
			render: () => ["click me", "second"],
			invalidate: () => {},
			handleClick: () => {
				clicks += 1;
				return true;
			},
		};
		tui.addChild(clickable);
		tui.addChild(new StaticLines(["DOCK"]));
		tui.pinFrom(tui.children[1]!);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		assert.strictEqual(clicks, 1);
		tui.stop();
	});

	it("drag does not fire handleClick", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		let clicks = 0;
		const clickable: Component = {
			render: () => ["click me", "second"],
			invalidate: () => {},
			handleClick: () => {
				clicks += 1;
				return true;
			},
		};
		tui.addChild(clickable);
		tui.addChild(new StaticLines(["DOCK"]));
		tui.pinFrom(tui.children[1]!);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;1;4M");
		terminal.sendInput("\x1b[<0;1;4m");
		await terminal.waitForRender();

		assert.strictEqual(clicks, 0);
		tui.stop();
	});

	it("click without drag copies nothing", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const selected: string[] = [];
		tui.onTextSelected = (text) => selected.push(text);
		tui.addChild(new SelectableLines(["hello", "world"]));
		tui.addChild(new StaticLines(["DOCK"]));
		tui.pinFrom(tui.children[1]!);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		assert.deepStrictEqual(selected, []);
		tui.stop();
	});

	it("press on a non-selectable child does not copy", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const selected: string[] = [];
		tui.onTextSelected = (text) => selected.push(text);
		tui.addChild(new StaticLines(["tool row", "more"]));
		tui.addChild(new StaticLines(["DOCK"]));
		tui.pinFrom(tui.children[1]!);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;1;2M");
		terminal.sendInput("\x1b[<0;1;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(selected, []);
		tui.stop();
	});
});
