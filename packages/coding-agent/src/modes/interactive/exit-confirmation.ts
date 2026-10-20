import { keyDisplayText } from "./components/keybinding-hints.ts";

/** How long the first `app.exit` press on an empty editor waits for the second one. */
export const EXIT_CONFIRM_WINDOW_MS = 1500;

/**
 * Two-press exit for `app.exit` (Ctrl+D), so deleting forward on an empty line cannot quit.
 * The startup view owns one and hands it to InteractiveMode, so a press made just before
 * hydration still counts. Call `press()` on every empty-editor press: it returns true for a
 * second press inside the window; otherwise the caller shows `hint`.
 */
export class ExitConfirmation {
	private armedAt: number | undefined;

	press(now = Date.now()): boolean {
		const confirmed = this.armedAt !== undefined && now - this.armedAt < EXIT_CONFIRM_WINDOW_MS;
		this.armedAt = confirmed ? undefined : now;
		return confirmed;
	}

	get hint(): string {
		return `Press ${keyDisplayText("app.exit")} again to exit`;
	}
}
