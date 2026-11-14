/**
 * lunR: allow and deny rules from `permissions.allow` / `permissions.deny` in settings.
 *
 * A rule is `tool` (every call of that tool) or `tool(pattern)`. Tool names match in any case, and
 * Claude Code's `:*` suffix reads as `*`.
 * - `bash(pattern)` is a glob over the command, where `*` matches anything, flags included
 *   (`bash(npm test)` is exactly `npm test`, `bash(git diff*)` also matches `git diff --output=f`).
 * - For the path tools (`PATH_TOOLS`) the pattern is a path glob resolved against the working
 *   directory: `*` stays inside one folder, `**` crosses folders, `~/` is home.
 * - Other tools take no pattern; such a rule never matches, and settings load warns about it.
 *
 * Allow rules match strictly: never a command with shell control or expansion characters, and only
 * a path whose real location matches, so `bash(npm test*)` can't approve `npm test; rm -rf ~`.
 * Deny rules over-match, because a deny that blocks too much fails closed: they check every command
 * the text could run after normalizing it (see `deniedCommandLines`) and let options sit between the
 * pattern's words (`bash(git push*)` matches `git -C repo push`). Both read the command text; a
 * command built at run time (`T=touch; $T f`) or a hard link to a denied file gets past them. They
 * stop a cooperating model from running something by accident, they are not a sandbox.
 *
 * Rules compile once per settings change and working directory (`compilePermissionRules`).
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { shellWords, splitShellSegments } from "./plan-mode.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export interface PermissionRuleSettings {
	allow?: string[];
	deny?: string[];
}

/** Tools whose rule pattern is a path glob over their `path` argument. */
export const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "ls", "grep", "find", "code_rewrite"]);

/** One call as rules see it. Each part is computed at most once per call, and only when a rule asks. */
interface CallView {
	command(): string | undefined;
	/** Normalized commands the text can run, for deny rules. */
	deniedCommandLines(): string[];
	/** The resolved path and its real location, for path rules. */
	paths(): { target: string; real: string | undefined } | undefined;
}

type Matcher = (call: CallView) => boolean;

interface CompiledRule {
	source: string;
	matches?: Matcher;
}

export interface CompiledPermissionRules {
	/** The first deny rule matching this call, if any. */
	denied(toolName: string, input: Record<string, unknown>): string | undefined;
	/** True when an allow rule matches this call. */
	allowed(toolName: string, input: Record<string, unknown>): boolean;
}

const RULE_SYNTAX = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/s;
/** Shell characters that chain, redirect or expand; an allow rule never matches a command with one. */
const SHELL_CONTROL = /[;&|<>$`()\n\r\\]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that start a command without being it. */
const COMMAND_PREFIX_WORDS = new Set(["!", "{", "(", "if", "then", "do", "else", "elif", "while", "until"]);
/** Commands that run the command after them, with the options of each that take a value. */
const WRAPPERS = new Map<string, ReadonlySet<string>>([
	["command", new Set()],
	["builtin", new Set()],
	["exec", new Set(["-a"])],
	["env", new Set(["-u", "-C", "-S", "--unset", "--chdir"])],
	["nohup", new Set()],
	["time", new Set()],
	["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
	["nice", new Set(["-n", "--adjustment"])],
	["stdbuf", new Set(["-i", "-o", "-e"])],
	["xargs", new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"])],
	["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"])],
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const MAX_NESTING = 4;

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern: string): RegExp {
	return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`, "s");
}

function basenameOf(word: string): string {
	return word.split(/[\\/]/).pop() ?? word;
}

/** Bodies of `$(...)`, `<(...)`, `>(...)` and backticks, which bash runs as commands of their own. */
function substitutionBodies(command: string): string[] {
	const bodies: string[] = [];
	for (let i = 0; i < command.length; i++) {
		const opens = (command[i] === "$" || command[i] === "<" || command[i] === ">") && command[i + 1] === "(";
		if (opens) {
			let depth = 1;
			let j = i + 2;
			for (; j < command.length && depth > 0; j++) {
				if (command[j] === "(") depth++;
				else if (command[j] === ")") depth--;
			}
			bodies.push(command.slice(i + 2, j - 1));
			i = j - 1;
		} else if (command[i] === "`") {
			const end = command.indexOf("`", i + 1);
			bodies.push(command.slice(i + 1, end === -1 ? undefined : end));
			if (end === -1) break;
			i = end;
		}
	}
	return bodies;
}

/** Index of the first word after a wrapper's own options (and timeout's duration). */
function skipWrapper(name: string, words: string[], start: number): number {
	const valued = WRAPPERS.get(name) ?? new Set<string>();
	let i = start;
	while (i < words.length && (words[i].startsWith("-") || (name === "env" && ASSIGNMENT.test(words[i])))) {
		if (words[i] === "--") return i + 1;
		i += valued.has(words[i]) ? 2 : 1;
	}
	if (name === "timeout" && i < words.length) i++;
	return i;
}

/** The commands one segment's words can run, each normalized to `name arg...`. */
function commandLinesFromWords(input: string[], depth: number): string[] {
	const words = input.map((word) => word.replace(/^[({]+/, "").replace(/[)}]+$/, "")).filter(Boolean);
	let i = 0;
	let viaXargs = false;
	while (i < words.length) {
		const name = basenameOf(words[i]);
		if (COMMAND_PREFIX_WORDS.has(words[i]) || ASSIGNMENT.test(words[i])) i++;
		else if (WRAPPERS.has(name)) {
			viaXargs ||= name === "xargs";
			i = skipWrapper(name, words, i + 1);
		} else break;
	}
	if (i >= words.length) return [];
	const name = basenameOf(words[i]);
	const args = words.slice(i + 1);
	const line = [name, ...args].join(" ");
	// xargs adds arguments from its input, so the command may get more than the text shows.
	const lines = viaXargs ? [line, `${line} _`] : [line];
	if (depth >= MAX_NESTING) return lines;
	if (SHELLS.has(name)) {
		const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		if (flag !== -1 && args[flag + 1] !== undefined) lines.push(...commandLines(args[flag + 1], depth + 1));
	} else if (name === "eval") {
		lines.push(...commandLines(args.join(" "), depth + 1));
	} else if (name === "find") {
		args.forEach((arg, index) => {
			if (!FIND_EXEC.has(arg)) return;
			const end = args.findIndex((word, after) => after > index && (word === ";" || word === "+"));
			lines.push(...commandLinesFromWords(args.slice(index + 1, end === -1 ? undefined : end), depth + 1));
		});
	}
	return lines;
}

/**
 * Every command the text can run, normalized for deny rules: split into segments the way read-only
 * mode splits them, unquoted, with substitutions, `sh -c`, `eval` and `find -exec` bodies opened,
 * leading assignments and wrappers (`command`, `env`, `timeout 5`, `xargs`, ...) dropped and the
 * command word reduced to its base name.
 */
function commandLines(command: string, depth = 0): string[] {
	const lines =
		depth < MAX_NESTING ? substitutionBodies(command).flatMap((body) => commandLines(body, depth + 1)) : [];
	for (const segment of splitShellSegments(command)) {
		lines.push(...commandLinesFromWords(shellWords(segment) ?? segment.split(/\s+/), depth));
	}
	return lines;
}

/**
 * Deny matching over words: the first pattern word is the command name, later ones may have option
 * words (and one value after each) before them, and a last word ending in `*` takes the rest.
 */
function wordsMatch(
	pattern: readonly RegExp[],
	last: RegExp | undefined,
	words: readonly string[],
	p = 0,
	w = 0,
): boolean {
	if (p === pattern.length) {
		if (!last) return w === words.length;
		if (last.test(words.slice(w).join(" "))) return true;
	} else if (w < words.length && pattern[p].test(words[w]) && wordsMatch(pattern, last, words, p + 1, w + 1)) {
		return true;
	}
	if (p === 0 || w >= words.length || !words[w].startsWith("-")) return false;
	if (wordsMatch(pattern, last, words, p, w + 1)) return true;
	return !words[w].includes("=") && w + 1 < words.length && wordsMatch(pattern, last, words, p, w + 2);
}

function bashMatcher(pattern: string, kind: "allow" | "deny"): Matcher {
	const whole = globRegex(pattern);
	if (kind === "allow") {
		return (call) => {
			const command = call.command();
			return command !== undefined && !SHELL_CONTROL.test(command) && whole.test(command);
		};
	}
	const words = pattern.split(/\s+/);
	const tail = words.at(-1)?.endsWith("*") ? words.pop() : undefined;
	const regexes = words.map(globRegex);
	const last = tail === undefined ? undefined : globRegex(tail);
	return (call) => {
		const command = call.command();
		if (command === undefined) return false;
		if (whole.test(command)) return true;
		// A one-word starred pattern (`git*`) matches the whole line.
		return call
			.deniedCommandLines()
			.some((line) => (regexes.length === 0 ? whole.test(line) : wordsMatch(regexes, last, line.split(" "))));
	};
}

function toSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Windows and macOS file systems ignore case by default, as `protected-targets.ts` assumes. */
function caseFlags(): string {
	return process.platform === "win32" || process.platform === "darwin" ? "si" : "s";
}

function pathGlobRegex(absoluteGlob: string): RegExp {
	let body = "";
	const glob = toSlashes(absoluteGlob);
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			body += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (ch === "*") body += "[^/]*";
		else if (ch === "?") body += "[^/]";
		else body += escapeRegex(ch);
	}
	return new RegExp(`^${body}$`, caseFlags());
}

function safeCanonical(path: string): string | undefined {
	try {
		return canonicalizeTargetPath(path);
	} catch {
		return undefined;
	}
}

/** The glob with its literal folder prefix replaced by that folder's real path, so symlinks compare equal. */
function canonicalGlob(absoluteGlob: string): string {
	const firstWildcard = absoluteGlob.search(/[*?]/);
	if (firstWildcard === -1) return safeCanonical(absoluteGlob) ?? absoluteGlob;
	const cut = Math.max(toSlashes(absoluteGlob).lastIndexOf("/", firstWildcard), 0);
	const prefix = safeCanonical(absoluteGlob.slice(0, cut) || "/");
	return prefix ? `${prefix.replace(/[/\\]$/, "")}${absoluteGlob.slice(cut)}` : absoluteGlob;
}

function pathMatcher(pattern: string, cwd: string, kind: "allow" | "deny"): Matcher {
	const expanded = pattern === "~" || pattern.startsWith("~/") ? `${homedir()}${pattern.slice(1)}` : pattern;
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const raw = pathGlobRegex(absolute);
	const canonical = pathGlobRegex(canonicalGlob(absolute));
	return (call) => {
		const paths = call.paths();
		if (!paths) return false;
		const real = paths.real === undefined ? undefined : toSlashes(paths.real);
		// Allow needs the real path to match, so a symlink inside an allowed folder can't reach outside it.
		if (kind === "allow") return real !== undefined && canonical.test(real);
		return raw.test(toSlashes(paths.target)) || (real !== undefined && canonical.test(real));
	};
}

/** Reads `tool` or `tool(pattern)`, or undefined for anything else, including empty parentheses. */
export function parsePermissionRule(source: string): { tool: string; pattern?: string } | undefined {
	const match = RULE_SYNTAX.exec(source.trim());
	if (!match) return undefined;
	const tool = match[1].toLowerCase();
	if (match[2] === undefined) return { tool };
	const pattern = match[2].trim().replace(/:\*$/, "*");
	return pattern ? { tool, pattern } : undefined;
}

/** Settings-load warnings for rules that would never match, one per rule. */
export function permissionRuleProblems(list: unknown, name: string): string[] {
	if (list === undefined) return [];
	if (!Array.isArray(list)) return [`${name} must be a list of rules such as "bash(npm test)"; it is ignored.`];
	return list.flatMap((source): string[] => {
		if (typeof source !== "string")
			return [`${name} has ${JSON.stringify(source)}, which is not a rule; it is ignored.`];
		const parsed = parsePermissionRule(source);
		if (!parsed) {
			return [`${name} has "${source}", which is not tool or tool(pattern); it is ignored.`];
		}
		if (parsed.pattern && parsed.tool !== "bash" && !PATH_TOOLS.has(parsed.tool)) {
			return [
				`${name} has "${source}", but ${parsed.tool} rules take no pattern, so it never matches. Write "${parsed.tool}".`,
			];
		}
		return [];
	});
}

function compileRule(source: string, cwd: string, kind: "allow" | "deny"): [string, CompiledRule] | undefined {
	const parsed = parsePermissionRule(source);
	if (!parsed) return undefined;
	if (!parsed.pattern) return [parsed.tool, { source }];
	if (parsed.tool === "bash") return [parsed.tool, { source, matches: bashMatcher(parsed.pattern, kind) }];
	if (PATH_TOOLS.has(parsed.tool)) return [parsed.tool, { source, matches: pathMatcher(parsed.pattern, cwd, kind) }];
	return [parsed.tool, { source, matches: () => false }];
}

function compileList(rules: readonly unknown[], cwd: string, kind: "allow" | "deny"): Map<string, CompiledRule[]> {
	const byTool = new Map<string, CompiledRule[]>();
	for (const source of rules) {
		if (typeof source !== "string") continue;
		const compiled = compileRule(source, cwd, kind);
		if (!compiled) continue;
		const [tool, rule] = compiled;
		byTool.set(tool, [...(byTool.get(tool) ?? []), rule]);
	}
	return byTool;
}

function callView(input: Record<string, unknown>, cwd: string): CallView {
	let lines: string[] | undefined;
	let paths: { target: string; real: string | undefined } | undefined | null = null;
	const command = () => (typeof input.command === "string" ? input.command.trim() : undefined);
	return {
		command,
		deniedCommandLines: () => {
			lines ??= commandLines(command() ?? "");
			return lines;
		},
		paths: () => {
			if (paths === null) {
				const target = typeof input.path === "string" && input.path ? resolveToCwd(input.path, cwd) : undefined;
				paths = target === undefined ? undefined : { target, real: safeCanonical(target) };
			}
			return paths;
		},
	};
}

function firstMatch(
	rules: Map<string, CompiledRule[]>,
	toolName: string,
	view: () => CallView,
): CompiledRule | undefined {
	const candidates = rules.get(toolName.toLowerCase());
	if (!candidates) return undefined;
	const call = view();
	return candidates.find((rule) => !rule.matches || rule.matches(call));
}

function asList(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** One compiled set per working directory, so gateway sessions in different folders don't recompile. */
const memo = new Map<string, { key: readonly unknown[]; rules: CompiledPermissionRules }>();

/**
 * Global rules apply everywhere. Project deny rules always add; project allow rules count only in a
 * trusted project, so a cloned repository cannot grant itself permissions.
 */
export function compilePermissionRules(
	global: PermissionRuleSettings | undefined,
	project: PermissionRuleSettings | undefined,
	projectTrusted: boolean,
	cwd: string,
): CompiledPermissionRules {
	const key = [global?.allow, global?.deny, project?.allow, project?.deny, projectTrusted, process.platform];
	const cached = memo.get(cwd);
	if (cached?.key.every((part, i) => part === key[i])) return cached.rules;
	const allow = compileList(
		[...asList(global?.allow), ...(projectTrusted ? asList(project?.allow) : [])],
		cwd,
		"allow",
	);
	const deny = compileList([...asList(global?.deny), ...asList(project?.deny)], cwd, "deny");
	// The gate asks deny, then allow, about the same arguments object; both share one view of it.
	const views = new WeakMap<Record<string, unknown>, CallView>();
	const view = (input: Record<string, unknown>) => () => {
		let call = views.get(input);
		if (!call) {
			call = callView(input, cwd);
			views.set(input, call);
		}
		return call;
	};
	const rules: CompiledPermissionRules = {
		denied: (toolName, input) => firstMatch(deny, toolName, view(input))?.source,
		allowed: (toolName, input) => firstMatch(allow, toolName, view(input)) !== undefined,
	};
	memo.set(cwd, { key, rules });
	return rules;
}

/**
 * The allow rule that would cover exactly this call, for "always allow": the exact command or the
 * exact resolved path. Undefined when no rule could match it (shell control characters) or the
 * tool takes no pattern.
 */
export function suggestAllowRule(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		if (!command || SHELL_CONTROL.test(command) || command.includes("*")) return undefined;
		return `bash(${command})`;
	}
	if (PATH_TOOLS.has(toolName) && typeof input.path === "string" && input.path) {
		const path = resolveToCwd(input.path, cwd);
		return /[*?()]/.test(path) ? undefined : `${toolName}(${path})`;
	}
	return undefined;
}
