import type { AssistantMessage } from "@earendil-works/pi-ai";
import { encodeKitty, resetCapabilitiesCache, setCapabilities, type Terminal, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CopyableTextBlockComponent } from "../src/modes/interactive/components/copyable-text.ts";
import { sliceMessageContent } from "../src/modes/interactive/smooth-streaming.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const attacks = [
	"\x1b]52;c;aW5lcnQ=\x07",
	"\x1b]0;inert title\x1b\\",
	"\x1b[999;999H",
	"\x1b[2J",
	"\x1bc",
	"\x1b[31m",
	"\x9d52;c;aW5lcnQ=\x9c",
	"\x9b999;999H",
	"\x1bPprivate\x1b\\",
	"\x1b_Ga=T;inert\x1b\\",
	"\x07",
	"\x08",
];
const payload = `before ${attacks.join("")} after`;

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

// Inspect inert strings and report booleans so assertion failures cannot replay source controls.
function expectSafeDisplay(rendered: string): void {
	const unstyled = rendered
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]133;[ABC]\x07/g, "")
		.replace(/\x1b\]8;;https:\/\/example.com\/\x1b\\/g, "")
		.replace(/\x1b\]8;;\x1b\\/g, "");
	expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(unstyled)).toBe(false);
}

beforeEach(() => {
	initTheme("moon");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
});
afterEach(() => {
	vi.useRealTimers();
	resetCapabilitiesCache();
});

describe("assistant terminal display boundary", () => {
	it.each(["prose", "code", "copyable"])("sanitizes %s before styling without changing source", (kind) => {
		const text =
			kind === "prose" ? payload : `\`\`\`${kind === "copyable" ? "lunr-copy" : "text"}\n${payload}\n\`\`\``;
		const source = message([{ type: "text", text }]);
		const original = JSON.stringify(source);
		const component = new AssistantMessageComponent(source);
		for (const width of [30, 100]) expectSafeDisplay(component.render(width).join("\n"));
		component.invalidate();
		expectSafeDisplay(component.render(60).join("\n"));
		expect(JSON.stringify(source) === original).toBe(true);
	});

	it.each(["completed", "collapsed", "expanded", "one-line", "four-lines"])("sanitizes %s thinking", (mode) => {
		const source = message([{ type: "thinking", thinking: payload }]);
		const original = JSON.stringify(source);
		const component = new AssistantMessageComponent(
			source,
			false,
			undefined,
			"Thinking...",
			1,
			mode === "collapsed",
			{
				reasoningDisplay: mode === "one-line" ? "one-line" : "four-lines",
			},
		);
		if (mode === "expanded") component.setExpanded(true);
		if (mode === "one-line" || mode === "four-lines") {
			component.setThinkingTimings([{ start: 0 }]);
			component.updateContent(source);
		}
		expectSafeDisplay(component.render(100).join("\n"));
		expect(JSON.stringify(source) === original).toBe(true);
	});

	it("keeps incomplete control sequences inert at every streaming reveal boundary", () => {
		const source = message([{ type: "text", text: `hello ${attacks.join("")} world` }]);
		const component = new AssistantMessageComponent();
		const length = source.content[0].type === "text" ? source.content[0].text.length : 0;
		for (let cursor = 0; cursor <= length; cursor++) {
			component.updateContent(sliceMessageContent(source, cursor), { thinkingSource: source });
			expectSafeDisplay(component.render(100).join("\n"));
		}
	});

	it.each(["aborted", "error"] as const)("sanitizes %s diagnostics", (stopReason) => {
		const source = { ...message([]), stopReason, errorMessage: payload };
		expectSafeDisplay(new AssistantMessageComponent(source).render(100).join("\n"));
		expect(source.errorMessage === payload).toBe(true);
	});

	it("sanitizes standalone copyable payloads and copy errors", () => {
		const onCopy = vi.fn();
		const component = new CopyableTextBlockComponent(payload, true, 1, { error: payload }, onCopy);
		expectSafeDisplay(component.render(100).join("\n"));
		expect(onCopy).not.toHaveBeenCalled();
	});

	it("copies the exact source only after a deliberate click", async () => {
		const copyText = vi.fn(async (_text: string) => {});
		const source = message([{ type: "text", text: `\`\`\`lunr-copy\n${payload}\n\`\`\`` }]);
		const component = new AssistantMessageComponent(source, false, undefined, "Thinking...", 1, false, { copyText });
		const lines = component.render(100);
		expectSafeDisplay(lines.join("\n"));
		expect(copyText).not.toHaveBeenCalled();
		const row = lines.findIndex((line) => line.includes("before"));
		expect(component.handleClick(row, 100, 0)).toBe(true);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(copyText.mock.calls[0]?.[0] === payload).toBe(true);
	});

	it("retains renderer styling, hyperlink and zone protocols", () => {
		const source = message([{ type: "text", text: `**bold** [link](https://example.com/) ${payload}` }]);
		const component = new AssistantMessageComponent(source, false, {
			...getMarkdownTheme(),
			bold: (text) => `\x1b[1m${text}\x1b[22m`,
		});
		const rendered = component.render(100).join("\n");
		expectSafeDisplay(rendered);
		expect(rendered.includes("\x1b[1m")).toBe(true);
		expect(rendered.includes("\x1b]8;;https://example.com/\x1b\\")).toBe(true);
		expect(rendered.includes("\x1b]133;A\x07")).toBe(true);
	});

	it("captures safe assistant output and trusted image protocols through the TUI", async () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const noop = () => {};
		const terminal: Terminal = {
			columns: 100,
			rows: 24,
			kittyProtocolActive: true,
			start: noop,
			stop: noop,
			drainInput: async () => {},
			write: (data) => {
				writes.push(data);
			},
			moveBy: noop,
			hideCursor: noop,
			showCursor: noop,
			clearLine: noop,
			clearFromCursor: noop,
			clearScreen: noop,
			setTitle: noop,
			setProgress: noop,
		};
		const tui = new TUI(terminal);
		const image = encodeKitty("aW5lcnQ=", { imageId: 42, columns: 1, rows: 1 });
		tui.addChild(new AssistantMessageComponent(message([{ type: "text", text: payload }])));
		tui.addChild({ render: () => [image], invalidate: noop });
		try {
			tui.start();
			await vi.advanceTimersByTimeAsync(100);
			const output = writes.join("");
			expect(writes.length > 0).toBe(true);
			// Full TUI paints intentionally emit clear-screen, styling and BEL-terminated zones.
			for (const attack of attacks.filter((value) => !["\x1b[31m", "\x1b[2J", "\x07"].includes(value))) {
				expect(output.includes(attack)).toBe(false);
			}
			expect(output.includes("\x1b_G")).toBe(true);
			expect(output.includes("aW5lcnQ=")).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
