/**
 * Leaving and suspending interactive mode: Ctrl+C and Ctrl+D to quit, Ctrl+Z to suspend, graceful
 * shutdown (from a key, /quit, an extension or a signal), the SIGTERM/SIGHUP and uncaught-error
 * handlers, and the exit when the terminal is gone. InteractiveMode owns one SessionExit and
 * supplies the TUI, the runtime and its teardown steps through SessionExitHost.
 */

import type { Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SIGNAL_DISPOSE_LIMIT_MS } from "../../core/agent-session-runtime.ts";
import * as processRegistry from "../../core/process-registry.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import type { ExitConfirmation } from "./exit-confirmation.ts";
import { theme } from "./theme/theme.ts";
import type { InteractiveThemeController } from "./theme/theme-controller.ts";

/** What leaving and suspending need from InteractiveMode. InteractiveMode builds one in `createSessionExitHost`. */
export interface SessionExitHost {
	readonly session: AgentSession;
	readonly runtimeHost: AgentSessionRuntime;
	readonly ui: TUI;
	readonly editor: EditorComponent;
	readonly chatContainer: Container;
	readonly themeController: InteractiveThemeController;
	/** The Ctrl+D window, shared with the startup view. */
	readonly exitConfirmation: ExitConfirmation;
	/** Set by an extension's shutdown() during a run; checked once the run settles. */
	readonly shutdownRequested: boolean;
	readonly unregisterSessionTransfer: (() => void) | undefined;
	clearEditor(): void;
	stopSmoothStreaming(): void;
	stopPlanUsagePolling(): void;
	/** Stops the TUI and restores the terminal. */
	stop(): void;
	confirmDisclaimerWithLabels(title: string, message: string): Promise<boolean>;
	showStatus(message: string): void;
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

/** Quit, suspend and signal handling for one InteractiveMode. */
export class SessionExit {
	private readonly host: SessionExitHost;
	private _lastSigintTime = 0;
	private _signalCleanupHandlers: Array<() => void> = [];
	private _isShuttingDown = false;

	constructor(host: SessionExitHost) {
		this.host = host;
	}

	/** True once shutdown, a dead terminal or a crash started ending the process. */
	get isShuttingDown(): boolean {
		return this._isShuttingDown;
	}

	/** Ctrl+C: clears the editor; a second press within 500 ms quits. */
	handleCtrlC(): void {
		const now = Date.now();
		if (now - this._lastSigintTime < 500) {
			void this.shutdown();
			return;
		}
		// A press on an empty editor has nothing to clear, so say what the next one does.
		const wasEmpty = this.host.editor.getText().length === 0;
		this.host.clearEditor();
		this._lastSigintTime = now;
		if (wasEmpty) setTimeout(this._addExitHint(`Press ${keyDisplayText("app.clear")} again to exit`), 500).unref?.();
	}

	/** Ctrl+D on an empty editor: the first press warns, a second within the window quits. */
	handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor). The first press only warns.
		if (this.host.exitConfirmation.press()) {
			void this.shutdown();
			return;
		}
		this.host.exitConfirmation.clearHintOnExpiry(this._addExitHint(this.host.exitConfirmation.hint));
	}

	// Adds a dim exit hint to the chat and returns the function that removes it once its window closes.
	private _addExitHint(message: string): () => void {
		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.host.chatContainer.addChild(spacer);
		this.host.chatContainer.addChild(text);
		this.host.ui.requestRender();
		return () => {
			this.host.chatContainer.removeChild(spacer);
			this.host.chatContainer.removeChild(text);
			this.host.ui.requestRender();
		};
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this._isShuttingDown) return;
		this._isShuttingDown = true;
		this.host.session.stopAdmission();
		this.host.unregisterSessionTransfer?.();
		this.host.stopSmoothStreaming();
		this.host.stopPlanUsagePolling();
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			const disposeLimit = setTimeout(() => {
				try {
					processRegistry.killAll();
				} catch {
					// Exit goes on even if a tracked process cannot be signalled.
				}
				this.host.stop();
				process.exit(0);
			}, SIGNAL_DISPOSE_LIMIT_MS);
			await this.host.runtimeHost.dispose();
			clearTimeout(disposeLimit);
			this.host.themeController.disableAutoSync();
			await this.host.ui.terminal.drainInput(1000);
			try {
				processRegistry.killAll();
			} catch {
				// Shutdown continues even if a tracked process cannot be signalled.
			}
			this.host.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.host.themeController.disableAutoSync();
		await this.host.ui.terminal.drainInput(1000);

		// lunr: quit prompt — ask about killing tracked processes before stopping the TUI.
		const tracked = processRegistry.list().filter((p) => p.status !== "exited");
		if (tracked.length > 0) {
			const shouldKill = await this.host.confirmDisclaimerWithLabels(
				"Session processes still running",
				`${tracked.length} process(es) started during this session are still alive.\nKill them before exit?`,
			);
			if (shouldKill) {
				processRegistry.killAll();
			}
		}

		this.host.stop();
		await this.host.runtimeHost.dispose();

		process.exit(0);
	}

	/** Exits at once, without terminal restore, when stdout or stderr reports a dead terminal. */
	emergencyTerminalExit(): never {
		this._isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		try {
			processRegistry.killAll();
		} catch {
			// The terminal is gone; nothing can report this, and exit must go on.
		}
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	uncaughtCrash(error: Error): never {
		if (this._isShuttingDown) {
			process.exit(1);
		}
		this._isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {
			// Crash path: keep going so the original error is printed.
		}
		try {
			killTrackedDetachedChildren();
		} catch {
			// Crash path: keep going so the original error is printed.
		}
		try {
			this.host.ui.stop();
		} catch {
			// Crash path: keep going so the original error is printed.
		}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	async checkShutdownRequested(): Promise<void> {
		if (!this.host.shutdownRequested) return;
		await this.shutdown();
	}

	/** SIGTERM and SIGHUP shut down gracefully; terminal errors and uncaught throws restore the terminal first. */
	registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this._signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this._signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this._signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this._signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	unregisterSignalHandlers(): void {
		for (const cleanup of this._signalCleanupHandlers) {
			cleanup();
		}
		this._signalCleanupHandlers = [];
	}

	/** Ctrl+Z: stops the TUI and suspends the process group; SIGCONT restores it. */
	handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.host.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.host.ui.start();
			this.host.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.host.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}
}
