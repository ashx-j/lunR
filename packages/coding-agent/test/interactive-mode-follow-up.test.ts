import { describe, expect, test, vi } from "vitest";

const runSlashCommand = vi.fn(async () => true);
vi.mock("../src/modes/interactive/slash-dispatch.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/slash-dispatch.ts")>()),
	runSlashCommand,
}));

const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");

function createFakeMode(isStreaming: boolean, text: string) {
	const fakeThis = {
		runtimeHost: { isDetached: false },
		transferInProgress: false,
		session: { isStreaming, isCompacting: false },
		slashCommandHost: {},
		editor: {
			getText: () => text,
			setText: vi.fn(),
			addToHistory: vi.fn(),
			onSubmit: vi.fn(),
		},
		takeSubmittedImages: vi.fn(() => []),
		loadImageAttachments: vi.fn(async () => undefined),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

const handleFollowUp = Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (
	this: ReturnType<typeof createFakeMode>,
) => Promise<void>;

describe("Alt+Enter with a builtin command", () => {
	test("while streaming, runs it at once and clears the editor", async () => {
		runSlashCommand.mockClear();
		const mode = createFakeMode(true, "/compact");
		await handleFollowUp.call(mode);
		expect(runSlashCommand).toHaveBeenCalledWith(mode.slashCommandHost, "/compact");
		expect(mode.editor.setText).toHaveBeenCalledWith("");
		expect(mode.editor.addToHistory).toHaveBeenCalledWith("/compact");
		expect(mode.editor.onSubmit).not.toHaveBeenCalled();
	});

	test("when idle, takes the regular submit path like Enter", async () => {
		runSlashCommand.mockClear();
		const mode = createFakeMode(false, "/compact");
		await handleFollowUp.call(mode);
		expect(runSlashCommand).not.toHaveBeenCalled();
		expect(mode.editor.setText).toHaveBeenCalledWith("");
		expect(mode.editor.onSubmit).toHaveBeenCalledWith("/compact", "/compact");
	});
});
