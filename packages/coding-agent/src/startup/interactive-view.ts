import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Component,
	Container,
	type EditorComponent,
	isFocusable,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { getChatboxEditor, renderStatsLine, thinkingThemeToken } from "../builtin-extensions/ashxj-tui.ts";
import { APP_NAME, getAgentDir, VERSION } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { registerPermissionModeBridge } from "../core/permission-mode.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { Settings } from "../core/settings-manager.ts";
import { BootScreenComponent } from "../modes/interactive/components/boot-screen.ts";
import { getEditorTheme, getThemeName, initTheme, theme } from "../modes/interactive/theme/theme.ts";
import { markStartupMilestone } from "./startup-milestones.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

// Read display preferences only: no auth, models, resources, migrations, or writes.
function readDisplaySettings(): Partial<Settings> {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

class StartupProcessTerminal extends ProcessTerminal {
	private watchForFirstFrame = false;
	private firstFrameCallback: (() => void) | undefined;

	setFirstFrameCallback(callback: () => void): void {
		this.firstFrameCallback = callback;
		this.watchForFirstFrame = true;
	}

	override start(onInput: (data: string) => void, onResize: () => void): void {
		super.start(onInput, onResize);
		markStartupMilestone("input_handler_armed");
		if (process.stdin.isTTY) markStartupMilestone("raw_mode_active");
	}

	override write(data: string): void {
		super.write(data);
		// TUI ends each content frame with synchronized-output end. Setup writes do not count.
		if (this.watchForFirstFrame && data.includes("\x1b[?2026l")) {
			this.watchForFirstFrame = false;
			markStartupMilestone("first_frame_committed");
			this.firstFrameCallback?.();
		}
	}
}

export class InteractiveView {
	readonly ui: TUI;
	readonly editor: ReturnType<typeof getChatboxEditor>;
	readonly keybindings: KeybindingsManager;
	private submitRequested = false;
	private inputUnsubscribe?: () => void;
	private modalActive = false;
	private readonly terminal: StartupProcessTerminal;
	private readonly status = new Text("", 1, 0);
	readonly header: Component;
	readonly footer: Component;
	readonly statusContainer = new Container();
	private readonly editorContainer = new Container();
	private firstFramePromise: Promise<void>;
	private resolveFirstFrame!: () => void;
	private exitPromise: Promise<void>;
	private resolveExit!: () => void;
	private started = false;
	private handedOff = false;
	private exitRequested = false;
	private lastClearAt = 0;
	private currentEditor: () => EditorComponent = () => this.editor;

	constructor() {
		const settings = readDisplaySettings();
		const permission = settings.defaultPermissionMode;
		registerPermissionModeBridge(() =>
			permission === "auto" || permission === "yolo" || permission === "plan" ? permission : "manual",
		);
		initTheme(typeof settings.theme === "string" ? settings.theme : undefined);
		this.terminal = new StartupProcessTerminal();
		this.ui = new TUI(this.terminal, settings.showHardwareCursor);
		this.ui.setClearOnShrink(settings.terminal?.clearOnShrink ?? false);
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const ctx = {
			mode: "tui" as const,
			hasUI: true,
			model: settings.defaultModel ? { id: settings.defaultModel, provider: settings.defaultProvider } : undefined,
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => undefined,
			ui: { theme, setEditorComponent() {}, setFooter() {} },
		};
		const effort = settings.defaultThinkingLevel ?? "off";
		this.editor = getChatboxEditor(this.ui, getEditorTheme(), this.keybindings as never, ctx, {
			getThinkingLevel: () => effort,
			on() {},
		});
		this.editor.borderColor = (text) => theme.fg(thinkingThemeToken(effort) as Parameters<typeof theme.fg>[0], text);
		this.editor.disableSubmit = true;
		this.header = settings.quietStartup
			? new Text("", 0, 0)
			: new BootScreenComponent(theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${VERSION}`), [
					{ label: "directory", value: process.cwd() },
					{ label: "config", value: getAgentDir() },
					{ label: "theme", value: getThemeName() },
				]);
		this.footer = {
			invalidate() {},
			render: (width) =>
				renderStatsLine(width, ctx, theme, {
					getGitBranch: () => null,
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 0,
					onBranchChange: () => () => {},
				}),
		};
		this.editorContainer.addChild(this.editor);
		this.statusContainer.addChild(this.status);
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
		this.restoreLayout();
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
		this.restoreLayout();
		this.ui.start();
		this.started = true;
	}

	waitForFirstFrame(): Promise<void> {
		return this.firstFramePromise;
	}

	waitForExit(): Promise<void> {
		return this.exitPromise;
	}

	binding(): InteractiveView {
		this.handedOff = true;
		return this;
	}

	setCurrentEditor(getEditor: () => EditorComponent): void {
		this.currentEditor = getEditor;
	}

	/** Called only after the normal submit handler and all extensions are ready. */
	activate(): void {
		if (this.exitRequested) return;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		this.editor.onPasteImage = undefined;
		this.editor.disableSubmit = false;
		this.status.setText("");
		if (this.submitRequested) {
			this.submitRequested = false;
			this.currentEditor().handleInput("\r");
		}
		this.ui.requestRender();
	}

	showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.status.setText(
			`Startup failed: ${message}\nYour draft is intact. Press Ctrl+C twice or Ctrl+D on an empty draft to exit.`,
		);
		this.editor.disableSubmit = true;
		this.statusContainer.clear();
		this.statusContainer.addChild(this.status);
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
		this.inputUnsubscribe?.();
		this.resolveFirstFrame();
		this.resolveExit();
	}

	async select<T>(title: string, options: Array<{ label: string; value: T }>): Promise<T | undefined> {
		const { ExtensionSelectorComponent } = await import("../modes/interactive/components/extension-selector.ts");
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				this.restoreLayout();
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
				this.restoreLayout();
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
				this.restoreLayout();
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
		this.modalActive = true;
		this.ui.pinFrom(null);
		this.ui.clear();
		this.ui.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender(true);
	}

	private restoreLayout(): void {
		this.modalActive = false;
		this.ui.pinFrom(null);
		this.ui.clear();
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.header);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footer);
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
		this.inputUnsubscribe = this.ui.addInputListener((data) => {
			const editor = this.currentEditor();
			if (this.modalActive || !isFocusable(editor) || !editor.focused) return;
			if (this.keybindings.matches(data, "tui.input.submit")) {
				this.submitRequested = editor.getText().trim().length > 0;
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "app.clear")) {
				this.submitRequested = false;
			}
			return undefined;
		});
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
