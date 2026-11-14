import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const PAGE_UP_PRESS = "\x1b[5~";
const PAGE_UP_RELEASE = "\x1b[5;1:3~";

describe("TUI input listeners", () => {
	it("skip Kitty key releases unless the listener opts in", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.setFocus(new InputRecorder());
		tui.start();

		const plain: string[] = [];
		const withReleases: string[] = [];
		tui.addInputListener((data) => {
			plain.push(data);
			return undefined;
		});
		tui.addInputListener(
			(data) => {
				withReleases.push(data);
				return undefined;
			},
			{ wantsKeyRelease: true },
		);

		terminal.sendInput(PAGE_UP_PRESS);
		terminal.sendInput(PAGE_UP_RELEASE);

		assert.deepStrictEqual(plain, [PAGE_UP_PRESS]);
		assert.deepStrictEqual(withReleases, [PAGE_UP_PRESS, PAGE_UP_RELEASE]);
		tui.stop();
	});
});
