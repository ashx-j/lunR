/**
 * /export and /import for interactive mode: write the session to HTML or JSONL, and replace it
 * with a JSONL file. InteractiveMode supplies the session, runtime and UI through
 * SessionFileCommandHost.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";

/** What /export and /import need from InteractiveMode. InteractiveMode builds one in `createSessionCommandHost`. */
export interface SessionFileCommandHost {
	readonly session: AgentSession;
	readonly runtimeHost: AgentSessionRuntime;
	showStatus(message: string): void;
	showError(message: string): void;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	clearStatusIndicator(): void;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
}

export async function handleExportCommand(host: SessionFileCommandHost, text: string): Promise<void> {
	const outputPath = getPathCommandArgument(text, "/export");

	try {
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = host.session.exportToJsonl(outputPath);
			host.showStatus(`Session exported to: ${filePath}`);
		} else {
			const filePath = await host.session.exportToHtml(outputPath);
			host.showStatus(`Session exported to: ${filePath}`);
		}
	} catch (error: unknown) {
		host.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

/** The path after `/export` or `/import`: the first word, or a quoted path with spaces. */
export function getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
	if (text === command) {
		return undefined;
	}
	if (!text.startsWith(`${command} `)) {
		return undefined;
	}

	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) {
		return undefined;
	}

	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		if (closingQuoteIndex < 0) {
			return undefined;
		}
		return argsString.slice(1, closingQuoteIndex);
	}

	const firstWhitespaceIndex = argsString.search(/\s/);
	if (firstWhitespaceIndex < 0) {
		return argsString;
	}
	return argsString.slice(0, firstWhitespaceIndex);
}

export async function handleImportCommand(host: SessionFileCommandHost, text: string): Promise<void> {
	const inputPath = getPathCommandArgument(text, "/import");
	if (!inputPath) {
		host.showError("Usage: /import <path.jsonl>");
		return;
	}

	const confirmed = await host.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
	if (!confirmed) {
		host.showStatus("Import cancelled");
		return;
	}

	try {
		host.clearStatusIndicator();
		const result = await host.runtimeHost.importFromJsonl(inputPath);
		if (result.cancelled) {
			host.showStatus("Import cancelled");
			return;
		}
		host.showStatus(`Session imported from: ${inputPath}`);
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Import cancelled");
				return;
			}
			const result = await host.runtimeHost.importFromJsonl(inputPath, selectedCwd);
			if (result.cancelled) {
				host.showStatus("Import cancelled");
				return;
			}
			host.showStatus(`Session imported from: ${inputPath}`);
			return;
		}
		if (error instanceof SessionImportFileNotFoundError) {
			host.showError(`Failed to import session: ${error.message}`);
			return;
		}
		await host.handleFatalRuntimeError("Failed to import session", error);
	}
}
