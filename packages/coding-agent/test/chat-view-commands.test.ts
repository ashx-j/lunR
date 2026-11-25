import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type HelpCommandHost, handleHotkeysCommand } from "../src/modes/interactive/help-commands.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { handleContextCommand, type UsageCommandHost } from "../src/modes/interactive/usage-commands.ts";

const ui = { terminal: { columns: 120 }, requestRender: vi.fn() } as unknown as TUI;

function renderedText(container: Container): string {
	return container
		.render(120)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(() => initTheme("moon"));

describe("/hotkeys", () => {
	it("lists extension shortcuts after the builtin keys", () => {
		const shortcuts = new Map([["ctrl+shift+g", { description: "Open goal panel", extensionPath: "goal.ts" }]]);
		const host: HelpCommandHost = {
			session: { extensionRunner: { getShortcuts: () => shortcuts } } as unknown as AgentSession,
			ui,
			chatContainer: new Container(),
			keybindings: KeybindingsManager.create(),
			getMarkdownTheme: (): MarkdownTheme => getMarkdownTheme(),
		};
		handleHotkeysCommand(host);
		const text = renderedText(host.chatContainer);
		expect(text).toContain("Keyboard Shortcuts");
		expect(text).toMatch(/Ctrl\+Shift\+G\s*│?\s*Open goal panel/);
	});
});

describe("/context", () => {
	it("reports a missing model as a status and draws nothing", () => {
		const host: UsageCommandHost = {
			session: { model: undefined } as unknown as AgentSession,
			ui,
			chatContainer: new Container(),
			showStatus: vi.fn(),
		};
		handleContextCommand(host);
		expect(host.showStatus).toHaveBeenCalledWith("No model selected or context window unknown.");
		expect(host.chatContainer.children).toHaveLength(0);
	});
});
