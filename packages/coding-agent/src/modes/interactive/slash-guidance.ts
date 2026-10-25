/**
 * First-run slash command guidance for interactive mode: the `/help` text and the check that keeps a
 * mistyped slash command from going to the model as a prompt.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

/**
 * Builtin names the interactive submit chain dispatches: the whole builtin table, hidden entries
 * included, because hidden commands still run when typed.
 */
export const INTERACTIVE_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

// Only plain command-shaped tokens. A second `/` or a `.` means a path; `:` covers `/skill:name` and
// duplicate extension names like `/foo:2`, which the session resolves or passes through itself.
const COMMAND_TOKEN = /^\/([a-z][a-z0-9-]*)$/;

/**
 * Returns the command name when `rawText` starts with a slash command nothing dispatches, else
 * undefined. `rawText` is the editor text before trimming, so a leading space opts out and sends the
 * text as a message. `isKnown` must answer from dispatch (builtins, extension commands, prompt
 * templates), not from what autocomplete shows. A token naming something on disk, at the filesystem
 * root (`/tmp`) or under `cwd`, is a path; the check costs at most two `existsSync` calls and runs only
 * for unknown names.
 */
export function findUnknownSlashCommand(
	rawText: string,
	isKnown: (name: string) => boolean,
	cwd: string,
): string | undefined {
	const name = COMMAND_TOKEN.exec(rawText.split(/\s/, 1)[0] ?? "")?.[1];
	if (!name || isKnown(name)) return undefined;
	return existsSync(`/${name}`) || existsSync(join(cwd, name)) ? undefined : name;
}

/**
 * Picks up to two command names for an unknown one. Close typos (edit distance at most 2, like `/modle`
 * or `/models`) rank first; the slash picker's fuzzy matcher fills any remaining slot.
 */
export function suggestSlashCommands(name: string, candidates: Iterable<string>): string[] {
	const names = [...new Set(candidates)].filter((candidate) => candidate !== name);
	const close = names
		.map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
		.filter(({ distance }) => distance <= 2)
		.sort((a, b) => a.distance - b.distance)
		.map(({ candidate }) => candidate);
	const fuzzy = fuzzyFilter(names, name, (candidate) => candidate);
	return [...new Set([...close, ...fuzzy])].slice(0, 2);
}

// Damerau-Levenshtein distance (optimal string alignment): insertions, deletions, substitutions and
// adjacent swaps each cost 1.
function editDistance(a: string, b: string): number {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = best;
		}
	}
	return rows[a.length]![b.length]!;
}

/** Status line shown when a submitted unknown command is put back in the editor. */
export function formatUnknownSlashCommandStatus(name: string, suggestions: readonly string[]): string {
	const options = suggestions.map((suggestion) => `/${suggestion}`).join(" or ");
	const didYouMean = options ? ` Did you mean ${options}?` : "";
	return `Unknown command /${name}.${didYouMean} Start with a space to send it as a message.`;
}

/** Status line shown when a builtin that takes no arguments is submitted with text after it. */
export function formatArgumentlessSlashCommandStatus(name: string): string {
	return `/${name} takes no arguments. Start with a space to send it as a message.`;
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
