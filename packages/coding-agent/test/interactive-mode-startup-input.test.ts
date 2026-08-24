import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type QueuedUserInput = { text: string; images?: unknown[] };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (input: QueuedUserInput) => void;
	pendingUserInputs: QueuedUserInput[];
	ui: { setChatScroll: (n: number) => void };
	takeSubmittedImages: () => [];
	consumeStagedSubmitImages: () => undefined;
	loadImageAttachments: (attachments: unknown[]) => Promise<undefined>;
};

type InputContext = {
	onInputCallback?: (input: QueuedUserInput) => void;
	pendingUserInputs: QueuedUserInput[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<QueuedUserInput>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		ui: { setChatScroll: vi.fn() },
		takeSubmittedImages: vi.fn(() => []),
		consumeStagedSubmitImages: vi.fn(() => undefined),
		loadImageAttachments: vi.fn(async () => undefined),
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", images: undefined }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("waits for deferred builtins before session.prompt but not getUserInput", async () => {
		let resolveAttach: (() => void) | undefined;
		const attach = new Promise<void>((resolve) => {
			resolveAttach = resolve;
		});
		const prompt = vi.fn(async () => {});
		const context = {
			deferredBuiltinAttachPromise: attach,
			session: { prompt },
			awaitDeferredBuiltinsForPrompt() {
				return proto.waitForDeferredBuiltins.call(this);
			},
		};
		const proto = InteractiveMode.prototype as unknown as {
			waitForDeferredBuiltins(this: { deferredBuiltinAttachPromise?: Promise<void> }): Promise<void>;
			promptAfterDeferredBuiltins(
				this: {
					awaitDeferredBuiltinsForPrompt(): Promise<void>;
					session: { prompt: typeof prompt };
				},
				text: string,
			): Promise<void>;
		};

		const wait = proto.waitForDeferredBuiltins.call(context);
		let waitSettled = false;
		void wait.then(() => {
			waitSettled = true;
		});
		await Promise.resolve();
		expect(waitSettled).toBe(false);

		const queued = proto.promptAfterDeferredBuiltins.call(context, "hello");
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();

		resolveAttach?.();
		await queued;
		expect(prompt).toHaveBeenCalledWith("hello", undefined);
	});
});
