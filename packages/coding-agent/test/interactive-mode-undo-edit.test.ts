import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type BranchEntry = {
	id: string;
	parentId?: string;
	type: "message";
	message: { role: "user" | "assistant" };
};

type UndoEditContext = {
	session: {
		isStreaming: boolean;
		navigateTree: (
			targetId: string,
			options: Record<string, unknown>,
		) => Promise<{
			cancelled: boolean;
			editorText?: string;
		}>;
	};
	sessionManager: {
		getBranch: () => BranchEntry[];
		getLeafId: () => string | null;
	};
	runtimeHost: { fork: ReturnType<typeof vi.fn> };
	redoStack: string[];
	editor: { setText: ReturnType<typeof vi.fn>; getText: () => string };
	chatContainer: { clear: ReturnType<typeof vi.fn> };
	renderInitialMessages: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	flushCompactionQueue: ReturnType<typeof vi.fn>;
};

type InteractiveModePrivate = {
	handleUndoCommand(this: UndoEditContext): Promise<void>;
	handleEditCommand(this: UndoEditContext): Promise<void>;
	handleRedoCommand(this: UndoEditContext): Promise<void>;
	rewindLastTurn(this: UndoEditContext, command: "undo" | "edit"): Promise<{ editorText?: string } | undefined>;
	restoreEditorFromTreeResult(this: UndoEditContext, result: { editorText?: string; editorImages?: unknown[] }): void;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function userBranch(): BranchEntry[] {
	return [
		{ id: "root", type: "message", message: { role: "user" } },
		{ id: "asst", parentId: "root", type: "message", message: { role: "assistant" } },
		{ id: "leaf", parentId: "asst", type: "message", message: { role: "user" } },
		{ id: "reply", parentId: "leaf", type: "message", message: { role: "assistant" } },
	];
}

function createContext(overrides: Partial<UndoEditContext> = {}): UndoEditContext & InteractiveModePrivate {
	const context = {
		session: {
			isStreaming: false,
			navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "please undo me" })),
		},
		sessionManager: {
			getBranch: () => userBranch(),
			getLeafId: () => "reply",
		},
		runtimeHost: { fork: vi.fn() },
		redoStack: [],
		editor: { setText: vi.fn(), getText: () => "" },
		chatContainer: { clear: vi.fn() },
		renderInitialMessages: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(),
		...overrides,
	} as UndoEditContext & InteractiveModePrivate;
	context.rewindLastTurn = proto.rewindLastTurn;
	context.handleUndoCommand = proto.handleUndoCommand;
	context.handleEditCommand = proto.handleEditCommand;
	context.handleRedoCommand = proto.handleRedoCommand;
	context.restoreEditorFromTreeResult = (result) => {
		context.editor.setText(result.editorText ?? "");
	};
	return context;
}

describe("InteractiveMode /undo and /edit", () => {
	it("/undo rewinds via navigateTree, does not fork, and does not fill the editor", async () => {
		const context = createContext();

		await proto.handleUndoCommand.call(context);

		expect(context.runtimeHost.fork).not.toHaveBeenCalled();
		expect(context.session.navigateTree).toHaveBeenCalledWith("leaf", {});
		expect(context.redoStack).toEqual(["reply"]);
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.chatContainer.clear).toHaveBeenCalled();
		expect(context.renderInitialMessages).toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Undone. /redo to restore.");
	});

	it("/edit rewinds via navigateTree and pastes the undone user text", async () => {
		const context = createContext();

		await proto.handleEditCommand.call(context);

		expect(context.runtimeHost.fork).not.toHaveBeenCalled();
		expect(context.session.navigateTree).toHaveBeenCalledWith("leaf", {});
		expect(context.redoStack).toEqual(["reply"]);
		expect(context.editor.setText).toHaveBeenCalledWith("please undo me");
		expect(context.showStatus).toHaveBeenCalledWith("Editing last message. /redo to restore.");
	});

	it("/redo navigates to the previous leaf after /undo", async () => {
		const navigateTree = vi.fn(async (targetId: string) => {
			if (targetId === "leaf") return { cancelled: false, editorText: "please undo me" };
			return { cancelled: false, editorText: undefined };
		});
		const context = createContext({
			session: { isStreaming: false, navigateTree },
		});

		await proto.handleUndoCommand.call(context);
		expect(context.redoStack).toEqual(["reply"]);

		await proto.handleRedoCommand.call(context);

		expect(navigateTree).toHaveBeenLastCalledWith("reply", {});
		expect(context.redoStack).toEqual([]);
		expect(context.showStatus).toHaveBeenLastCalledWith("Redone");
	});

	it("does not rewind while streaming", async () => {
		const context = createContext({
			session: {
				isStreaming: true,
				navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "x" })),
			},
		});

		await proto.handleUndoCommand.call(context);
		await proto.handleEditCommand.call(context);

		expect(context.session.navigateTree).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalled();
	});
});
