import { describe, expect, it, vi } from "vitest";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

describe("image paste keybinding", () => {
	it("routes a matched terminal sequence through the normal app action", () => {
		const handler = vi.fn();
		const editor = {
			keybindings: {
				matches: (data: string, action: string) => data === "\x1b[118;3u" && action === "app.clipboard.pasteImage",
			},
			actionHandlers: new Map([["app.clipboard.pasteImage", handler]]),
		} as unknown as CustomEditor;

		CustomEditor.prototype.handleInput.call(editor, "\x1b[118;3u");

		expect(handler).toHaveBeenCalledOnce();
	});
});
