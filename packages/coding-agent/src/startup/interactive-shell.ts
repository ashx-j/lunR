import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	Container,
	type EditorImageAttachment,
	type EditorTheme,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { markStartupMilestone } from "./startup-milestones.ts";

export interface StartupShellSubmission {
	text: string;
	attachments: EditorImageAttachment[];
}

export interface InteractiveShellBinding {
	ui: TUI;
	editor: CustomEditor;
	keybindings: KeybindingsManager;
	pendingSubmissions: StartupShellSubmission[];
}

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

const identity = (text: string) => text;
const shellEditorTheme: EditorTheme = {
	borderColor: (text) => `\x1b[38;5;60m${text}\x1b[0m`,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

class StartupProcessTerminal extends ProcessTerminal {
	private watchForFirstFrame = false;
	private firstFrameCallback: (() => void) | undefined;

	setFirstFrameCallback(callback: () => void): void {
		this.firstFrameCallback = callback;
		this.watchForFirstFrame = true;
	}

	override start(onInput: (data: string) => void, onResize: () => void): void {
		markStartupMilestone("input_handler_armed");
		super.start(onInput, onResize);
		markStartupMilestone("raw_mode_active");
	}

	override write(data: string): void {
		super.write(data);
		if (this.watchForFirstFrame && data.includes("Starting lunR")) {
			this.watchForFirstFrame = false;
			markStartupMilestone("first_frame_committed");
			this.firstFrameCallback?.();
		}
	}
}

export class InteractiveStartupShell {
	readonly ui: TUI;
	readonly editor: CustomEditor;
	readonly keybindings: KeybindingsManager;
	readonly pendingSubmissions: StartupShellSubmission[] = [];
	private readonly terminal: StartupProcessTerminal;
	private readonly status = new Text("Starting lunR. You can type now.", 1, 0);
	private readonly editorContainer = new Container();
	private firstFramePromise: Promise<void>;
	private resolveFirstFrame!: () => void;
	private exitPromise: Promise<void>;
	private resolveExit!: () => void;
	private started = false;
	private handedOff = false;
	private exitRequested = false;
	private lastClearAt = 0;

	constructor() {
		this.terminal = new StartupProcessTerminal();
		this.ui = new TUI(this.terminal);
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.editor = new CustomEditor(this.ui, shellEditorTheme, this.keybindings, { paddingX: 1 });
		this.editorContainer.addChild(this.editor);
		this.firstFramePromise = new Promise((resolve) => {
			this.resolveFirstFrame = resolve;
		});
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.terminal.setFirstFrameCallback(this.resolveFirstFrame);
		this.installInputHandlers();
	}

	get isExitRequested(): boolean {
		return this.exitRequested;
	}

	start(): void {
		if (this.started) return;
		this.restoreShellLayout();
		this.ui.setAlternateScreen(true);
		this.ui.start();
		this.started = true;
	}

	pause(): void {
		if (!this.started || this.handedOff) return;
		this.ui.stop();
		this.started = false;
	}

	resume(): void {
		if (this.started || this.handedOff || this.exitRequested) return;
		this.restoreShellLayout();
		this.ui.start();
		this.started = true;
	}

	waitForFirstFrame(): Promise<void> {
		return this.firstFramePromise;
	}

	binding(): InteractiveShellBinding {
		this.handedOff = true;
		return {
			ui: this.ui,
			editor: this.editor,
			keybindings: this.keybindings,
			pendingSubmissions: this.pendingSubmissions,
		};
	}

	showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.status.setText(
			`Startup failed: ${message}\nYour draft is intact. Press Ctrl+C twice or Ctrl+D on an empty draft to exit.`,
		);
		this.editor.disableSubmit = true;
		this.ui.requestRender();
	}

	async fail(error: unknown): Promise<void> {
		this.showError(error);
		if (process.env.PI_STARTUP_BENCHMARK === "1") {
			this.stop();
			return;
		}
		await this.exitPromise;
	}

	stop(): void {
		if (this.exitRequested) return;
		this.exitRequested = true;
		if (this.started) {
			this.ui.stop();
			this.started = false;
		}
		this.resolveExit();
	}

	async select<T>(title: string, options: Array<{ label: string; value: T }>): Promise<T | undefined> {
		const { ExtensionSelectorComponent } = await import("../modes/interactive/components/extension-selector.ts");
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				this.restoreShellLayout();
				resolve(value);
			};
			const selector = new ExtensionSelectorComponent(
				title,
				options.map((option) => option.label),
				(label) => finish(options.find((option) => option.label === label)?.value),
				() => finish(undefined),
				{ tui: this.ui },
			);
			this.showModal(selector, selector);
		});
	}

	async confirm(title: string, message: string): Promise<boolean> {
		return (
			(await this.select(`${title}\n${message}`, [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			])) ?? false
		);
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		const { ExtensionInputComponent } = await import("../modes/interactive/components/extension-input.ts");
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				input.dispose();
				this.restoreShellLayout();
				resolve(value);
			};
			const input = new ExtensionInputComponent(title, placeholder, finish, () => finish(undefined), {
				tui: this.ui,
			});
			this.showModal(input, input);
		});
	}

	async selectSession(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
	): Promise<string | null> {
		const { SessionSelectorComponent } = await import("../modes/interactive/components/session-selector.ts");
		return new Promise((resolve) => {
			let settled = false;
			const finish = (path: string | null) => {
				if (settled) return;
				settled = true;
				this.restoreShellLayout();
				resolve(path);
			};
			const selector = new SessionSelectorComponent(
				currentSessionsLoader,
				allSessionsLoader,
				(path) => finish(path),
				() => finish(null),
				() => this.stop(),
				() => this.ui.requestRender(),
				{ showRenameHint: false, keybindings: this.keybindings },
			);
			this.showModal(selector, selector.getSessionList());
		});
	}

	private showModal(component: Parameters<TUI["addChild"]>[0], focus: Parameters<TUI["setFocus"]>[0]): void {
		this.ui.pinFrom(null);
		this.ui.clear();
		this.ui.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender(true);
	}

	private restoreShellLayout(): void {
		this.ui.pinFrom(null);
		this.ui.clear();
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.status);
		this.ui.addChild(this.editorContainer);
		this.ui.pinFrom(this.editorContainer);
		this.ui.setFocus(this.editor);
		this.ui.requestRender(true);
	}

	private installInputHandlers(): void {
		this.editor.onAction("app.clear", () => {
			const now = Date.now();
			if (this.editor.getText().length === 0 && now - this.lastClearAt < 500) {
				this.stop();
				return;
			}
			this.editor.setText("");
			this.lastClearAt = now;
		});
		this.editor.onCtrlD = () => this.stop();
		this.editor.onPasteImage = () => void this.pasteClipboard();
		this.editor.onSubmit = (text) => {
			const attachments = this.editor.takePendingImages();
			if (!text.trim()) return;
			if (this.pendingSubmissions.length > 0) {
				this.editor.setText(text);
				this.editor.restoreImageMarkers(attachments);
				this.status.setText("One prompt is already queued. Your current draft will stay in the editor.");
				this.ui.requestRender();
				return;
			}
			this.pendingSubmissions.push({ text, attachments });
			this.editor.addToHistory(text);
			this.status.setText("Prompt queued. Finishing startup before it can run.");
			this.ui.requestRender();
		};
	}

	private async pasteClipboard(): Promise<void> {
		try {
			const [{ readClipboardText }, { extensionForImageMimeType, readClipboardImage }] = await Promise.all([
				import("../utils/clipboard.ts"),
				import("../utils/clipboard-image.ts"),
			]);
			const image = await readClipboardImage();
			if (image) {
				const extension = extensionForImageMimeType(image.mimeType) ?? "png";
				const filePath = path.join(os.tmpdir(), `lunr-clipboard-${crypto.randomUUID()}.${extension}`);
				fs.writeFileSync(filePath, Buffer.from(image.bytes));
				const id = this.editor.insertImageMarker({ path: filePath, mimeType: image.mimeType });
				this.status.setText(`Pasted [image_${id}] while startup continues.`);
				this.ui.requestRender();
				return;
			}
			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor(text);
				this.ui.requestRender();
				return;
			}
			this.status.setText("Clipboard contains no image or text.");
		} catch (error) {
			this.status.setText(`Clipboard paste failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.ui.requestRender();
	}
}
