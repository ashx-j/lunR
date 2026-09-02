import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE } from "../src/mouse.ts";
import { type Component, TUI, visibleWidth } from "../src/tui.ts";
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

	getLines(): string[] {
		return this.lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class CountingLines extends Lines {
	renders = 0;

	override render(): string[] {
		this.renders++;
		return super.render();
	}
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

	it("setChatScroll does not re-render chat children when only the offset changes", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new CountingLines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		tui.render(20);
		const afterLayout = chat.renders;
		assert.ok(afterLayout >= 1);

		for (let i = 0; i < 10; i++) {
			tui.setChatScroll(i);
		}
		const frame = tui.render(20);
		assert.strictEqual(chat.renders, afterLayout);
		assert.ok(frame[0]!.startsWith("C0"));
		assert.deepStrictEqual(frame.slice(6), ["D0", "D1"]);
	});

	it("wheel burst does not re-layout chat children", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new CountingLines(40, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await terminal.waitForRender();

		const afterLayout = chat.renders;
		assert.ok(afterLayout >= 1);
		for (let i = 0; i < 10; i++) {
			terminal.sendInput("\x1b[<64;1;1M");
		}
		await terminal.waitForRender();

		assert.strictEqual(chat.renders, afterLayout);
		assert.strictEqual(tui.getChatScroll(), 30);
		tui.stop();
	});

	it("keeps the gutter without a second width collect, and drops it when chat hugs again", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new CountingLines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const tall = tui.render(20);
		assert.ok(tall.slice(0, 6).every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));
		const afterOverflow = chat.renders;
		assert.ok(afterOverflow >= 1);

		tui.setChatScroll(2);
		const scrolled = tui.render(20);
		assert.strictEqual(chat.renders, afterOverflow);
		assert.ok(scrolled[0]!.startsWith("C2"));
		assert.ok(scrolled.slice(0, 6).every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));

		chat.setLines(["C0", "C1", "C2"]);
		tui.requestRender(true);
		const hug = tui.render(20);
		assert.deepStrictEqual(hug, ["C0", "C1", "C2", "D0", "D1"]);
		assert.ok(hug.every((line) => lastVisible(line) !== "│" && lastVisible(line) !== "█"));
	});

	it("does not re-layout static chat for dock-only paint requests", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new CountingLines(10_000, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		tui.render(20);
		const afterLayout = chat.renders;
		for (let i = 0; i < 100; i++) {
			tui.requestPaint();
			tui.render(20);
		}

		assert.strictEqual(chat.renders, afterLayout);
	});

	it("invalidates cached chat for normal render requests", () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const chat = new Text("first", 0, 0);
		const dock = new Lines(["DOCK"]);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		tui.render(20);
		chat.setText("second");
		tui.requestRender();
		const frame = tui.render(20);

		assert.ok(frame.some((line) => line.startsWith("second")));
	});

	it("re-layouts chat when a nested box changes", () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const chat = new Box(0, 0);
		const dock = new Lines(["DOCK"]);
		chat.addChild(new Lines(["first"]));
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		tui.render(20);
		chat.addChild(new Lines(["second"]));
		const frame = tui.render(20);

		assert.ok(frame.some((line) => line.startsWith("second")));
	});

	it("keeps one-column pinned frames within the terminal width", () => {
		const terminal = new VirtualTerminal(1, 4);
		const tui = new TUI(terminal);
		const chat = new Lines(6, "C");
		const dock = new Lines(["DOCK"]);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const frame = tui.render(1);
		assert.ok(frame.every((line) => visibleWidth(line) <= 1));
		assert.ok(frame.every((line) => lastVisible(line) !== "│" && lastVisible(line) !== "█"));
	});

	it("keeps the newest line visible when the viewport starts inside Kitty image rows", () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const image = "\x1b_Ga=T,r=3,i=1;AAAA\x1b\\";
		const chat = new Lines([image, "", "", "new-1", "newest"]);
		const dock = new Lines(["DOCK"]);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const frame = tui.render(20);
		assert.ok(frame.some((line) => line.startsWith("newest")));
		assert.strictEqual(tui.getChatScroll(), 0);
	});

	it("scrollbar glyphs are not written back into cached chat lines", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const bottom = tui.render(20);
		tui.setChatScroll(4);
		const top = tui.render(20);

		assert.ok(bottom.slice(0, 6).every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));
		assert.ok(top.slice(0, 6).every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));
		assert.ok(chat.getLines().every((line) => !line.includes("█") && !line.includes("│")));
		assert.ok(top[0]!.startsWith("C0"));
		assert.ok(bottom[0]!.startsWith("C4"));
	});

	it("press+motion+release on the last column drags the thumb without copying", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const selected: string[] = [];
		tui.onTextSelected = (text) => selected.push(text);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);
		assert.strictEqual(tui.getChatScroll(), 0);

		// Last column (x=20). At offset 0 the thumb sits on the bottom rows (y=3–6);
		// press the thumb and drag up to scroll into older chat.
		terminal.sendInput("\x1b[<0;20;6M");
		terminal.sendInput("\x1b[<32;20;1M");
		terminal.sendInput("\x1b[<0;20;1m");
		await terminal.waitForRender();

		assert.ok(tui.getChatScroll() > 0);
		assert.deepStrictEqual(selected, []);
		tui.stop();
	});

	it("press on the track jumps, then drag continues from there", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(10, "C");
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);
		tui.start();
		await renderPinned(tui, terminal);

		terminal.sendInput("\x1b[<0;20;1M");
		await terminal.waitForRender();
		const afterJump = tui.getChatScroll();
		assert.ok(afterJump > 0);

		terminal.sendInput("\x1b[<32;20;6M");
		terminal.sendInput("\x1b[<0;20;6m");
		await terminal.waitForRender();
		assert.notStrictEqual(tui.getChatScroll(), afterJump);
		tui.stop();
	});

	it("gutter glyphs reset SGR so red chat lines do not tint the thumb", () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const chat = new Lines(Array.from({ length: 10 }, (_, i) => `\x1b[31mC${i}`));
		const dock = new Lines(2, "D");
		tui.addChild(chat);
		tui.addChild(dock);
		tui.pinFrom(dock);

		const frame = tui.render(20);
		const chatSlice = frame.slice(0, 6);
		assert.ok(chatSlice.every((line) => lastVisible(line) === "│" || lastVisible(line) === "█"));
		assert.ok(chatSlice.some((line) => /\x1b\[0m(?:\x1b\[[0-9;]*m)*[█│]/.test(line)));
		assert.ok(chatSlice.every((line) => !/31m[█│]/.test(line)));
	});
});
