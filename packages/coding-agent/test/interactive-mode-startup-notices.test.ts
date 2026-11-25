import { Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode startup notices", () => {
	beforeAll(() => {
		initTheme("moon");
	});

	test("a startup check that finishes after the first prompt shows above that prompt", () => {
		const chatContainer = new Container();
		const startupNotices = new Container();
		chatContainer.addChild(startupNotices);
		chatContainer.addChild(new Text("● go", 0, 0));
		chatContainer.addChild(new Text("● $ echo hi", 0, 0));
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
			chatContainer,
			startupNotices,
			ui: { requestRender() {} },
		});

		InteractiveMode.prototype["showStartupNotice"].call(mode, "warning", "tmux extended-keys is off.");

		const lines = chatContainer
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		expect(lines).toEqual(["Warning: tmux extended-keys is off.", "● go", "● $ echo hi"]);
	});
});
