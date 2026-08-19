import assert from "node:assert";
import { describe, it } from "node:test";
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE } from "../src/mouse.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class RecordingInput implements Component {
	received: string[] = [];
	handleInput(data: string): void {
		this.received.push(data);
	}
	render(): string[] {
		return ["DOCK"];
	}
	invalidate(): void {}
}

class Lines implements Component {
	private lines: string[];

	constructor(count: number, prefix: string);
	constructor(lines: string[]);
	constructor(countOrLines: number | string[], prefix = "L") {
		if (Array.isArray(countOrLines)) {
			this.lines = countOrLines;
		} else {
			this.lines = Array.from({ length: countOrLines }, (_, i) => `${prefix}${i}`);
		}
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate(): void {}
}

function strip(line: string): string {
	return line.replace(/\s+$/, "");
}

function lastVisible(line: string): string {
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "");
	return plain.slice(-1);
}

async function renderPinned(tui: TUI, terminal: VirtualTerminal): Promise<string[]> {
	tui.requestRender();
	await terminal.waitForRender();
	return terminal.getViewport().map(strip);
}

describe("TUI pinFrom dock", () => {
	it("short chat hugs content and does not pin the dock to the screen bottom", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		const chat = new Lines(3, "C");
		const dock = new Lines(3, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();

		const frame = tui.render(20);
		assert.deepStrictEqual(frame, ["C0", "C1", "C2", "D0", "D1", "D2"]);
		assert.ok(frame.slice(0, 3).every((line) => lastVisible(line) !== "│" && lastVisible(line) !== "█"));

		const viewport = await renderPinned(tui, terminal);
		assert.strictEqual(viewport[0], "C0");
		assert.ok(viewport.includes("D2"));
		assert.ok(tui.isPinned());
		assert.strictEqual(tui.getChatScroll(), 0);
		assert.strictEqual(tui.getChatViewportHeight(), 7);

		tui.stop();
	});

	it("tall chat at offset 0 shows the latest lines and no pad", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		const viewport = await renderPinned(tui, terminal);

		const frame = tui.render(20);
		assert.strictEqual(frame.length, 8);
		assert.ok(frame[0]!.startsWith("C4"));
		assert.ok(frame[5]!.startsWith("C9"));
		assert.deepStrictEqual(frame.slice(6), ["D0", "D1"]);
		assert.ok(frame.slice(0, 6).every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));
		assert.ok(!viewport.some((line) => line.includes("C0")));
		assert.ok(!viewport.some((line) => line.includes("C3")));
		assert.ok(viewport.some((line) => line.includes("C4")));
		assert.ok(viewport.some((line) => line.includes("C9")));
		assert.strictEqual(viewport[viewport.length - 1], "D1");
		assert.ok(!frame.includes(""));
		assert.strictEqual(tui.getChatViewportHeight(), 6);

		tui.stop();
	});

	it("tall chat scrolled up shows an older slice; dock stays last rows", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);

		tui.setChatScroll(3);
		const viewport = await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), 3);
		const scrolled = tui.render(20);
		assert.ok(scrolled[0]!.startsWith("C1"));
		assert.ok(scrolled[5]!.startsWith("C6"));
		assert.deepStrictEqual(scrolled.slice(6), ["D0", "D1"]);
		assert.ok(viewport.some((line) => line.includes("C1")));
		assert.ok(!viewport.some((line) => line.includes("C0")));
		assert.ok(!viewport.some((line) => line.includes("C9")));
		assert.strictEqual(viewport[viewport.length - 1], "D1");
		assert.strictEqual(viewport[viewport.length - 2], "D0");

		tui.scrollChat(100);
		assert.strictEqual(tui.getChatScroll(), 4);
		tui.scrollChat(-2);
		assert.strictEqual(tui.getChatScroll(), 2);

		tui.stop();
	});

	it("growing dock shrinks the chat viewport and stays on the last rows", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(["D0", "D1"]);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatViewportHeight(), 6);

		dock.setLines(["D0", "D1", "D2", "D3"]);
		const viewport = await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatViewportHeight(), 4);
		const grown = tui.render(20);
		assert.ok(grown[0]!.startsWith("C6"));
		assert.ok(grown[3]!.startsWith("C9"));
		assert.deepStrictEqual(grown.slice(4), ["D0", "D1", "D2", "D3"]);
		assert.ok(!viewport.some((line) => line.includes("C5")));
		assert.ok(viewport.some((line) => line.includes("C6")));
		assert.strictEqual(viewport[viewport.length - 1], "D3");
		assert.strictEqual(viewport.length, 8);

		tui.stop();
	});

	it("unpinned mode still concatenates and grows", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const content = new Lines(["first", "second"]);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		assert.ok(!tui.isPinned());
		assert.deepStrictEqual(tui.render(20), ["first", "second"]);
		let viewport = terminal.getViewport().map(strip);
		assert.ok(viewport.some((line) => line.includes("first")));
		assert.ok(viewport.some((line) => line.includes("second")));

		content.setLines(["first", "second", "third", "fourth"]);
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.render(20), ["first", "second", "third", "fourth"]);
		viewport = terminal.getViewport().map(strip);
		assert.ok(viewport.some((line) => line.includes("fourth")));

		tui.stop();
	});

	it("overlay is visible on a short pinned frame", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const chat = new Lines(["Line 1", "Line 2", "Line 3"]);
		const dock = new Lines(["DOCK"]);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.showOverlay(new SimpleOverlay());
		tui.start();
		await terminal.waitForRender();

		const frame = tui.render(80);
		assert.deepStrictEqual(frame, ["Line 1", "Line 2", "Line 3", "DOCK"]);

		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("OVERLAY")),
			"Overlay should be visible on a short pinned frame",
		);

		tui.stop();
	});

	it("pinFrom(null) restores unpinned concatenation", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(2, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		assert.deepStrictEqual(tui.render(20), ["C0", "C1", "D0", "D1"]);
		tui.pinFrom(null);
		assert.ok(!tui.isPinned());
		assert.deepStrictEqual(tui.render(20), ["C0", "C1", "D0", "D1"]);
	});

	it("enables SGR mouse tracking while pinned and disables on unpin/stop", () => {
		const terminal = new RecordingTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();

		assert.ok(
			terminal.writes.some((w) => w.includes(MOUSE_TRACKING_ENABLE)),
			"should enable 1000+1002+1006 while pinned",
		);

		tui.pinFrom(null);
		assert.ok(
			terminal.writes.some((w) => w.includes(MOUSE_TRACKING_DISABLE)),
			"should disable mouse tracking when unpinned",
		);

		tui.pinFrom(dock);
		const disableCountBeforeStop = terminal.writes.filter((w) => w.includes(MOUSE_TRACKING_DISABLE)).length;
		tui.stop();
		const disableCountAfterStop = terminal.writes.filter((w) => w.includes(MOUSE_TRACKING_DISABLE)).length;
		assert.ok(disableCountAfterStop > disableCountBeforeStop, "should disable mouse tracking on stop");
	});

	it("wheel up on a tall pinned chat shows older lines; dock stays last rows", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);

		terminal.sendInput("\x1b[<64;1;1M");
		const viewport = await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), 3);
		const wheeled = tui.render(20);
		assert.ok(wheeled[0]!.startsWith("C1"));
		assert.deepStrictEqual(wheeled.slice(6), ["D0", "D1"]);
		assert.ok(viewport.some((line) => line.includes("C1")));
		assert.ok(!viewport.some((line) => line.includes("C9")));
		assert.strictEqual(viewport[viewport.length - 1], "D1");

		terminal.sendInput("\x1b[<65;1;1M");
		await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), 0);

		tui.stop();
	});

	it("ctrl+wheel pages by the chat viewport height", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(20, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);

		const viewH = tui.getChatViewportHeight();
		terminal.sendInput("\x1b[<80;1;1M");
		await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), viewH);

		tui.stop();
	});

	it("does not leak mouse sequences into the focused dock input", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new RecordingInput();
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.setFocus(dock);
		tui.start();
		await renderPinned(tui, terminal);

		terminal.sendInput("\x1b[<64;1;1M");
		terminal.sendInput("\x1b[<0;2;2M");
		await renderPinned(tui, terminal);
		assert.deepStrictEqual(dock.received, []);
		assert.strictEqual(tui.getChatScroll(), 3);

		tui.stop();
	});

	it("does not scroll chat when a capturing overlay has focus", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.showOverlay(new SimpleOverlay());
		tui.start();
		await renderPinned(tui, terminal);

		terminal.sendInput("\x1b[<64;1;1M");
		await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), 0);

		tui.stop();
	});

	it("ignores wheel when unpinned", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		tui.addChild(chat);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.getChatScroll(), 0);

		tui.stop();
	});

	it("draws a scrollbar on tall chat and moves the thumb when scrolling up", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const bottom = tui.render(20);
		assert.deepStrictEqual(bottom.slice(6), ["D0", "D1"]);
		const bottomThumb = bottom.slice(0, 6).map(lastVisible);
		assert.ok(bottomThumb.includes("█"));
		assert.ok(bottomThumb.includes("│"));
		const bottomThumbStart = bottomThumb.indexOf("█");

		tui.setChatScroll(4);
		const top = tui.render(20);
		assert.ok(top[0]!.startsWith("C0"));
		assert.deepStrictEqual(top.slice(6), ["D0", "D1"]);
		const topThumb = top.slice(0, 6).map(lastVisible);
		const topThumbStart = topThumb.indexOf("█");
		assert.ok(topThumbStart >= 0);
		assert.ok(topThumbStart < bottomThumbStart);
		assert.strictEqual(tui.getChatViewportHeight(), 6);
	});
});
