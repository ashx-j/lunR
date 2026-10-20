/**
 * First-run slash command guidance for interactive mode: the `/help` text and the check that keeps a
 * mistyped slash command from going to the model as a prompt.
 */

import { fuzzyFilter } from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

/**
 * Builtin names the interactive submit chain dispatches: the whole builtin table plus `debug`, which
 * the chain handles without a table entry. Keep entries here even when autocomplete hides them.
 */
export const INTERACTIVE_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
	...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
	"debug",
]);

// Only plain command-shaped tokens. A second `/` or a `.` means a path; `:` covers `/skill:name` and
// duplicate extension names like `/foo:2`, which the session resolves or passes through itself.
const COMMAND_TOKEN = /^\/([a-z][a-z0-9-]*)$/;

/**
 * Returns the command name when `rawText` starts with a slash command nothing dispatches, else
 * undefined. `rawText` is the editor text before trimming, so a leading space opts out and sends the
 * text as a message. `isKnown` must answer from dispatch (builtins, extension commands, prompt
 * templates), not from what autocomplete shows.
 */
export function findUnknownSlashCommand(rawText: string, isKnown: (name: string) => boolean): string | undefined {
	const name = COMMAND_TOKEN.exec(rawText.split(/\s/, 1)[0] ?? "")?.[1];
	return name && !isKnown(name) ? name : undefined;
}

/** Picks up to two command names for an unknown one, ranked by the slash picker's fuzzy matcher. */
export function suggestSlashCommands(name: string, candidates: Iterable<string>): string[] {
	return fuzzyFilter([...new Set(candidates)], name, (candidate) => candidate)
		.filter((candidate) => candidate !== name)
		.slice(0, 2);
}

/** Status line shown when a submitted unknown command is put back in the editor. */
export function formatUnknownSlashCommandStatus(name: string, suggestions: readonly string[]): string {
	const options = suggestions.map((suggestion) => `/${suggestion}`).join(" or ");
	const didYouMean = options ? ` Did you mean ${options}?` : "";
	return `Unknown command /${name}.${didYouMean} Start with a space to send it as a message.`;
}

type HelpEntry = readonly [command: string, description: string];

// One `/help` row with two aligned command columns.
function helpRow(left: HelpEntry, right: HelpEntry): string {
	const leftCell = `${left[0].padEnd(14)}${left[1]}`;
	return `  ${leftCell.padEnd(36)}${right[0].padEnd(11)}${right[1]}`;
}

const HELP_SECTIONS: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
	{
		title: "Getting started",
		lines: [
			helpRow(["/login", "add a provider"], ["/model", "pick a model"]),
			helpRow(["/mode", "yolo | auto | read"], ["/thinking", "reasoning level"]),
			helpRow(["/settings", "all options"], ["/hotkeys", "every key"]),
		],
	},
	{ title: "Sessions", lines: ["  /new  /resume  /fork  /undo  /compact  /rollback"] },
	{
		title: "Tools and agents",
		lines: [
			helpRow(["/run", "start a subagent"], ["/goal", "long-running goal"]),
			helpRow(["/cron", "scheduled jobs"], ["/mcp", "MCP servers"]),
		],
	},
];

/**
 * Builds the `/help` lines. Key names come from the live keybindings; an unbound key drops its
 * sentence. `heading` styles section titles.
 */
export function buildHelpLines(
	keys: { cyclePermissionMode: string; interrupt: string },
	heading: (title: string) => string,
): string[] {
	const lines = HELP_SECTIONS.flatMap((section) => [heading(section.title), ...section.lines, ""]);
	lines.push("Type / to see every command.");
	const keyHints = [
		keys.cyclePermissionMode && `${keys.cyclePermissionMode} cycles the permission mode.`,
		keys.interrupt && `${keys.interrupt} interrupts.`,
	].filter(Boolean);
	if (keyHints.length > 0) lines.push(keyHints.join(" "));
	return lines;
}
