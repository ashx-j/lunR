import { appendDebugLog } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";

/**
 * Stray-output handler for the interactive ProcessTerminal. Text that extensions or libraries write to
 * stdout or stderr while the TUI draws the screen goes to the debug log, because on the screen it would
 * leave stale rows. Extensions that want the user to see a message use `ctx.ui.notify`.
 */
export function logStrayOutput(text: string, stream: "stdout" | "stderr"): void {
	const trimmed = stripAnsi(text).trimEnd();
	if (trimmed) appendDebugLog(`${stream}: ${trimmed}`);
}
