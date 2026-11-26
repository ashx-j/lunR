import { Container, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionDialogs, type ExtensionDialogsHost } from "../src/modes/interactive/extension-dialogs.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("moon"));

function createHost() {
	const editor = { render: () => [] } as unknown as EditorComponent;
	const ui = { setFocus: vi.fn(), requestRender: vi.fn() };
	const host = { ui: ui as unknown as TUI, editorContainer: new Container(), editor, keybindings: {} };
	host.editorContainer.addChild(editor);
	return { host, ui, editor };
}

describe("ExtensionDialogs", () => {
	it("puts the editor back and resolves undefined when the select's signal aborts", async () => {
		const { host, ui, editor } = createHost();
		const dialogs = new ExtensionDialogs(host as unknown as ExtensionDialogsHost);
		const controller = new AbortController();
		const pending = dialogs.select("Pick one", ["a", "b"], { signal: controller.signal });
		expect(host.editorContainer.children[0]).not.toBe(editor);
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(host.editorContainer.children).toEqual([editor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
	});

	it("hideAll closes an open input and puts the editor back", () => {
		const { host, editor } = createHost();
		const dialogs = new ExtensionDialogs(host as unknown as ExtensionDialogsHost);
		void dialogs.input("Name");
		expect(host.editorContainer.children[0]).not.toBe(editor);
		dialogs.hideAll();
		expect(host.editorContainer.children).toEqual([editor]);
	});
});
