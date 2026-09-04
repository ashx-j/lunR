import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

type QueuedUserInput = { text: string; images?: Array<{ type: "image"; mimeType: string; data: string }> };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
		takePendingImages?: () => Array<{ id: number; path: string; mimeType: string }>;
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
	settingsManager: { getImageAutoResize: () => boolean };
	showStatus: (message: string) => void;
	handleClipboardPaste: (options?: { textFallback?: boolean }) => Promise<void>;
	takeSubmittedImages: () => Array<{ id: number; path: string; mimeType: string }>;
	consumeStagedSubmitImages: () => undefined;
	activateDeferredStartupEditor: () => void;
	loadImageAttachments: (
		attachments: Array<{ id: number; path: string; mimeType: string }>,
	) => Promise<Array<{ type: "image"; mimeType: string; data: string }> | undefined>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	loadImageAttachments(
		this: {
			settingsManager: { getImageAutoResize: () => boolean };
			showStatus: (message: string) => void;
		},
		attachments: Array<{ id: number; path: string; mimeType: string }>,
	): Promise<Array<{ type: "image"; mimeType: string; data: string }> | undefined>;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivate;

describe("InteractiveMode image paste chips", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `lunr-image-paste-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads pending chips as ImageContent in first-appearance order", async () => {
		const first = join(dir, "one.png");
		const second = join(dir, "two.png");
		writeFileSync(first, Buffer.from(TINY_PNG_BASE64, "base64"));
		writeFileSync(second, Buffer.from(TINY_PNG_BASE64, "base64"));

		const images = await proto.loadImageAttachments.call(
			{
				settingsManager: { getImageAutoResize: () => false },
				showStatus: vi.fn(),
			},
			[
				{ id: 2, path: second, mimeType: "image/png" },
				{ id: 1, path: first, mimeType: "image/png" },
			],
		);

		expect(images).toHaveLength(2);
		expect(images?.[0]?.type).toBe("image");
		expect(images?.[0]?.mimeType).toBe("image/png");
		expect(images?.[1]?.mimeType).toBe("image/png");
	});

	it("submits chip text plus loaded images", async () => {
		const first = join(dir, "one.png");
		writeFileSync(first, Buffer.from(TINY_PNG_BASE64, "base64"));
		const loaded = [
			{
				type: "image" as const,
				mimeType: "image/png",
				data: TINY_PNG_BASE64,
			},
		];
		const context: SubmitContext = {
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
			settingsManager: { getImageAutoResize: () => false },
			showStatus: vi.fn(),
			handleClipboardPaste: vi.fn(async () => {}),
			takeSubmittedImages: vi.fn(() => [{ id: 1, path: first, mimeType: "image/png" }]),
			consumeStagedSubmitImages: vi.fn(() => undefined),
			activateDeferredStartupEditor: vi.fn(),
			loadImageAttachments: vi.fn(async () => loaded),
		};

		proto.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("look at [image_1]");

		expect(context.pendingUserInputs).toEqual([{ text: "look at [image_1]", images: loaded }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
	});

	it("runs /paste-image without sending a model prompt", async () => {
		const context: SubmitContext = {
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
			settingsManager: { getImageAutoResize: () => false },
			showStatus: vi.fn(),
			handleClipboardPaste: vi.fn(async () => {}),
			takeSubmittedImages: vi.fn(() => []),
			consumeStagedSubmitImages: vi.fn(() => undefined),
			activateDeferredStartupEditor: vi.fn(),
			loadImageAttachments: vi.fn(async () => undefined),
		};

		proto.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/paste-image");

		expect(context.handleClipboardPaste).toHaveBeenCalledWith({ textFallback: false });
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});
});
