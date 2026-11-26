/**
 * The dialogs interactive mode shows in place of the editor: the generic selector swap, and the
 * select, confirm, input, multi-line editor and custom component dialogs extensions open through
 * their UI context (`ctx.ui`). ExtensionDialogs owns the open dialog and puts the editor back when
 * it closes. InteractiveMode supplies the UI and the current editor through ExtensionDialogsHost.
 */

import type { Component, Container, EditorComponent, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../core/session-cwd.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { type Theme, theme } from "./theme/theme.ts";

/** What the dialogs need from InteractiveMode. InteractiveMode builds one in `createExtensionDialogsHost`. */
export interface ExtensionDialogsHost {
	readonly ui: TUI;
	/** The container that holds the editor; a dialog takes its place there while open. */
	readonly editorContainer: Container;
	/** The current editor, which extensions can replace; a closing dialog puts it back. */
	readonly editor: EditorComponent;
	readonly keybindings: KeybindingsManager;
	readonly settingsManager: SettingsManager;
	toggleToolOutputExpansion(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

/** The dialog open in place of the editor, if any. InteractiveMode owns one. */
export class ExtensionDialogs {
	private readonly host: ExtensionDialogsHost;
	private _selector: ExtensionSelectorComponent | undefined = undefined;
	private _input: ExtensionInputComponent | undefined = undefined;
	private _editor: ExtensionEditorComponent | undefined = undefined;

	constructor(host: ExtensionDialogsHost) {
		this.host = host;
	}

	/** Closes an open select, input or editor dialog, as a session replacement does. */
	hideAll(): void {
		if (this._selector) {
			this._hideSelector();
		}
		if (this._input) {
			this._hideInput();
		}
		if (this._editor) {
			this._hideEditor();
		}
	}

	/**
	 * Show a selector for extensions.
	 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this._hideSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this._selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this._hideSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this._hideSelector();
					resolve(undefined);
				},
				{
					tui: this.host.ui,
					timeout: opts?.timeout,
					onToggleToolsExpanded: () => this.host.toggleToolOutputExpansion(),
				},
			);
			if (opts?.initialIndex !== undefined) this._selector.setSelectedIndex(opts.initialIndex);

			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this._selector);
			this.host.ui.setFocus(this._selector);
			this.host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private _hideSelector(): void {
		this._selector?.dispose();
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this._selector = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.select(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.confirm("Session cwd not found", formatMissingSessionCwdPrompt(error.issue));
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this._hideInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this._input = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this._hideInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this._hideInput();
					resolve(undefined);
				},
				{ tui: this.host.ui, timeout: opts?.timeout },
			);

			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this._input);
			this.host.ui.setFocus(this._input);
			this.host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private _hideInput(): void {
		this._input?.dispose();
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this._input = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	editText(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this._editor = new ExtensionEditorComponent(
				this.host.ui,
				this.host.keybindings,
				title,
				prefill,
				(value) => {
					this._hideEditor();
					resolve(value);
				},
				() => {
					this._hideEditor();
					resolve(undefined);
				},
				undefined,
				this.host.settingsManager.getExternalEditorCommand(),
			);

			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this._editor);
			this.host.ui.setFocus(this._editor);
			this.host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private _hideEditor(): void {
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this._editor = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	notify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.host.showError(message);
		} else if (type === "warning") {
			this.host.showWarning(message);
		} else {
			this.host.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	async custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.host.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.host.editor);
			this.host.editor.setText(savedText);
			this.host.ui.setFocus(this.host.editor);
			this.host.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.host.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.host.ui, theme, this.host.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.host.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.host.editorContainer.clear();
						this.host.editorContainer.addChild(component);
						this.host.ui.setFocus(component);
						this.host.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.host.editor);
			this.host.ui.setFocus(this.host.editor);
		};
		const { component, focus } = create(done);
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(component);
		this.host.ui.setFocus(focus);
		this.host.ui.requestRender();
	}
}
