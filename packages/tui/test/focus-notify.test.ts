import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("terminal focus reporting", () => {
	it("tracks focus reports without passing them to the focused component", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		const component = new InputRecorder();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		try {
			tui.setFocusReporting(true);
			assert.ok(terminal.writes.includes("\x1b[?1004h"));
			assert.strictEqual(tui.isTerminalFocused(), undefined);

			terminal.sendInput("\x1b[O");
			assert.strictEqual(tui.isTerminalFocused(), false);
			terminal.sendInput("\x1b[I");
			assert.strictEqual(tui.isTerminalFocused(), true);
			assert.deepStrictEqual(component.inputs, []);

			tui.setFocusReporting(false);
			assert.ok(terminal.writes.includes("\x1b[?1004l"));
			assert.strictEqual(tui.isTerminalFocused(), undefined);
		} finally {
			tui.stop();
		}
	});

	it("turns focus reporting off when the TUI stops and back on when it restarts", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.start();
		tui.setFocusReporting(true);
		tui.stop();
		assert.ok(terminal.writes.includes("\x1b[?1004l"));
		terminal.writes.length = 0;
		tui.start();
		try {
			assert.ok(terminal.writes.includes("\x1b[?1004h"));
		} finally {
			tui.stop();
		}
	});
});

describe("TUI notify", () => {
	it("rings the bell or sends an OSC 9 notice without control characters", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.start();
		try {
			tui.notify("bell", "ignored");
			assert.ok(terminal.writes.includes("\x07"));
			tui.notify("desktop", "lunR\x07finished\x1b");
			assert.ok(terminal.writes.includes("\x1b]9;lunR finished\x07"));
		} finally {
			tui.stop();
		}
	});
});
