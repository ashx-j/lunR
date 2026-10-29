import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTransferHandler, SessionTransferError } from "../src/core/session-handoff.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "lunr-tui-handoff-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	cleanups.push(() => manager.dispose());
	manager.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	manager.flush();
	let text = "unsent draft";
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
	};
	// Like the real editor, submitting clears the text before onSubmit runs.
	const submit = (value: string) => {
		text = "";
		return editor.onSubmit!(value);
	};
	const state = {
		sessionManager: manager,
		runtimeHost: {
			isDetached: false,
			services: { agentDir: directory },
			switchSession: vi.fn(async (file: string) => {
				state.sessionManager = SessionManager.open(file);
				cleanups.push(() => state.sessionManager.dispose());
				state.runtimeHost.isDetached = false;
				return { cancelled: false };
			}),
		},
		editor,
		defaultEditor: editor,
		detachedDraft: "unsent draft",
		transferInProgress: false,
		showStatus: vi.fn(),
		showError: vi.fn(),
		takeSubmittedImages: () => [],
	};
	const prototype = InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof state): void };
	prototype.setupEditorSubmitHandler.call(state);
	return { state, editor, submit, manager, directory };
}

describe("TUI session reclaim", () => {
	it("keeps a detached terminal alive and its draft intact when the owner refuses transfer", async () => {
		const { state, editor, submit, manager } = harness();
		state.runtimeHost.isDetached = true;
		cleanups.push(
			registerTransferHandler(manager, async () => {
				throw new SessionTransferError("Still busy. Wait, stop or cancel.", "busy");
			}),
		);
		await submit("a new prompt");
		expect(state.showError).toHaveBeenCalledWith(expect.stringContaining("Draft retained"));
		expect(editor.getText()).toBe("a new prompt");
		await submit("/reclaim");
		expect(state.showError).toHaveBeenCalledWith(expect.stringContaining("Still busy"));
		expect(state.detachedDraft).toBe("unsent draft");
		expect(state.runtimeHost.switchSession).not.toHaveBeenCalled();
		manager.assertWritable();
	});

	it("reclaims only after release, reloads saved state and restores the pre-transfer draft", async () => {
		const { state, editor, submit, manager } = harness();
		manager.resetLeaf();
		state.runtimeHost.isDetached = true;
		cleanups.push(
			registerTransferHandler(manager, async () => {
				manager.dispose();
			}),
		);
		await submit("/reclaim");
		expect(state.showError).not.toHaveBeenCalled();
		expect(state.sessionManager).not.toBe(manager);
		expect(state.sessionManager.getLeafId()).toBeNull();
		expect(editor.getText()).toBe("unsent draft");
		expect(state.runtimeHost.isDetached).toBe(false);
	});
});
