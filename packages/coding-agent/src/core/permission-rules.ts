/**
 * lunR: allow and deny rules from `permissions.allow` / `permissions.deny` in settings.
 *
 * A rule is `tool` (every call of that tool) or `tool(pattern)`. Tool names match in any case, and
 * Claude Code's `:*` suffix reads as `*`.
 * - `bash(pattern)`: `*` matches any text, flags included (`bash(npm test)` is exactly `npm test`,
 *   `bash(git diff*)` also matches `git diff --output=f` and `git diff-tree`).
 * - For the path tools (`PATH_TOOLS`) the pattern is a path glob resolved against the working
 *   directory: `*` and `?` stay inside one folder, `**` spans any number of folders, `~/` is home.
 * - Other tools take no pattern; such a rule never matches, and settings load warns about it.
 *
 * Allow rules match strictly: the whole command text, never one with shell control or expansion
 * characters, and only a path whose real location matches. Deny rules match each command the text
 * can run (`deniedCommandLines`, with its limits), let options and one value each sit between the
 * pattern's words (`git -C repo push`), and read a short-flag word as a set (`-rf` matches `-r -f`).
 * Rules stop a cooperating model from running something by accident; they are not a sandbox.
 *
 * Every match is linear in the rule and the command: globs never backtrack, word matching is
 * memoized, and `MAX_RULES` / `MAX_RULE_LENGTH` cap each list. A deny rule past a cap still blocks
 * every call of its tool, so dropping it fails closed, and settings load warns about it.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { type DeniedLine, deniedCommandLines } from "./permission-rule-commands.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export interface PermissionRuleSettings {
	allow?: string[];
	deny?: string[];
}

/** Tools whose rule pattern is a path glob over their `path` argument. */
export const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "ls", "grep", "find", "code_rewrite"]);
/** Rules read from one settings list (global allow, project deny, ...). */
export const MAX_RULES = 200;
export const MAX_RULE_LENGTH = 300;

/** One call as rules see it. Each part is computed at most once per call, and only when a rule asks. */
interface CallView {
	command(): string | undefined;
	deniedLines(): DeniedLine[];
	/** The resolved path and its real location as segments, for path rules. */
	paths(): { target: string[]; real: string[] | undefined } | undefined;
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
const SHORT_FLAGS = /^-[A-Za-z]+$/;

/** True when `text` matches `glob`, where `*` is any text. Greedy piece search, so it never backtracks. */
function globMatch(glob: string, text: string): boolean {
	const pieces = glob.split("*");
	if (pieces.length === 1) return glob === text;
	const first = pieces[0];
	const last = pieces[pieces.length - 1];
	if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
	let at = first.length;
	const end = text.length - last.length;
	for (const piece of pieces.slice(1, -1)) {
		const found = text.indexOf(piece, at);
		if (found === -1 || found + piece.length > end) return false;
		at = found + piece.length;
	}
	return true;
}

/** `glob` against one path segment, where `*` is any text and `?` one character, without backtracking. */
function segmentMatch(glob: string, segment: string): boolean {
	const pieces = glob.split("*");
	const pieceAt = (piece: string, at: number) =>
		[...piece].every((ch, k) => ch === "?" || ch === segment[at + k]) && at + piece.length <= segment.length;
	if (pieces.length === 1) return glob.length === segment.length && pieceAt(glob, 0);
	const first = pieces[0];
	const last = pieces[pieces.length - 1];
	const end = segment.length - last.length;
	if (end < first.length || !pieceAt(first, 0) || !pieceAt(last, end)) return false;
	let at = first.length;
	for (const piece of pieces.slice(1, -1)) {
		let found = -1;
		for (let i = at; i + piece.length <= end; i++) {
			if (pieceAt(piece, i)) {
				found = i;
				break;
			}
		}
		if (found === -1) return false;
		at = found + piece.length;
	}
	return true;
}

/** Path segments against glob segments, `**` spanning any number of them. Memoized, so O(P × S). */
function segmentsMatch(glob: readonly string[], path: readonly string[]): boolean {
	// Most rules differ from the path in a literal folder near the start; settle those without the table.
	let start = 0;
	while (start < glob.length && !/[*?]/.test(glob[start])) {
		if (start >= path.length || glob[start] !== path[start]) return false;
		start++;
	}
	if (start === glob.length) return start === path.length;
	return segmentsMatchFrom(glob.slice(start), path.slice(start));
}

function segmentsMatchFrom(glob: readonly string[], path: readonly string[]): boolean {
	const memo = new Int8Array((glob.length + 1) * (path.length + 1));
	const at = (g: number, s: number): boolean => {
		const key = g * (path.length + 1) + s;
		if (memo[key] !== 0) return memo[key] === 1;
		let result: boolean;
		if (g === glob.length) result = s === path.length;
		else if (glob[g] === "**") result = at(g + 1, s) || (s < path.length && at(g, s + 1));
		else result = s < path.length && segmentMatch(glob[g], path[s]) && at(g + 1, s + 1);
		memo[key] = result ? 1 : 2;
		return result;
	};
	return at(0, 0);
}

type PatternWord = { kind: "glob"; glob: string } | { kind: "flags"; flags: ReadonlySet<string> };

interface DenyPattern {
	words: PatternWord[];
	/** A starred last word: a glob over the rest of the line. */
	tail?: string;
	/** A starred last flag word (`-rf*`): any text may follow the flags. */
	restAllowed: boolean;
}

function patternWord(word: string): PatternWord {
	return SHORT_FLAGS.test(word) && word.length > 2
		? { kind: "flags", flags: new Set(word.slice(1)) }
		: { kind: "glob", glob: word };
}

function compileDenyPattern(pattern: string): DenyPattern {
	const words = pattern.split(/\s+/);
	const last = words[words.length - 1];
	// One starred word (`sudo*`, `curl*`) is a glob over the command name, followed by anything.
	if (words.length === 1 && last.endsWith("*")) return { words: [patternWord(last)], restAllowed: true };
	if (last.endsWith("*")) {
		words.pop();
		const flags = last.slice(0, -1);
		if (SHORT_FLAGS.test(flags) && flags.length > 2) {
			return { words: [...words.map(patternWord), patternWord(flags)], restAllowed: true };
		}
		return { words: words.map(patternWord), tail: last, restAllowed: false };
	}
	return { words: words.map(patternWord), restAllowed: false };
}

/**
 * Deny matching over one line's words, memoized on (pattern word, line word) so it stays O(P × W²):
 * the first pattern word is the command name, later ones may have option words (and one value after
 * each) before them, a flag word takes a run of short options, and a starred last word takes the rest.
 */
function denyLineMatch(pattern: DenyPattern, line: DeniedLine): boolean {
	const { words } = line;
	const P = pattern.words.length;
	const W = words.length;
	const memo = new Int8Array((P + 1) * (W + 1));
	const at = (p: number, w: number): boolean => {
		const key = p * (W + 1) + w;
		if (memo[key] !== 0) return memo[key] === 1;
		let result = false;
		if (p === P) {
			result =
				pattern.restAllowed ||
				(pattern.tail === undefined ? w === W : globMatch(pattern.tail, words.slice(w).join(" ")));
		} else if (w < W) {
			const word = pattern.words[p];
			if (p === 0) {
				result = (line.wildcard || (word.kind === "glob" ? globMatch(word.glob, words[0]) : false)) && at(1, 1);
			} else if (word.kind === "glob") {
				result = globMatch(word.glob, words[w]) && at(p + 1, w + 1);
			} else {
				const seen = new Set<string>();
				for (let k = w; k < W && SHORT_FLAGS.test(words[k]) && !result; k++) {
					for (const flag of words[k].slice(1)) seen.add(flag);
					if ([...word.flags].every((flag) => seen.has(flag))) result = at(p + 1, k + 1);
				}
			}
		}
		if (!result && p > 0 && w < W && words[w].startsWith("-")) {
			result = at(p, w + 1) || (!words[w].includes("=") && w + 1 < W && at(p, w + 2));
		}
		memo[key] = result ? 1 : 2;
		return result;
	};
	return P === 0 ? false : at(0, 0);
}

function bashMatcher(pattern: string, kind: "allow" | "deny"): Matcher {
	if (kind === "allow") {
		return (call) => {
			const command = call.command();
			return command !== undefined && !SHELL_CONTROL.test(command) && globMatch(pattern, command);
		};
	}
	const compiled = compileDenyPattern(pattern);
	return (call) => call.deniedLines().some((line) => denyLineMatch(compiled, line));
}

function toSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Windows and macOS file systems ignore case by default, as `protected-targets.ts` assumes. */
function foldCase(path: string): string {
	return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

function pathSegments(path: string): string[] {
	return foldCase(toSlashes(path)).split("/");
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
	const raw = pathSegments(absolute);
	const canonical = pathSegments(canonicalGlob(absolute));
	return (call) => {
		const paths = call.paths();
		if (!paths) return false;
		// Allow needs the real path to match, so a symlink inside an allowed folder can't reach outside it.
		if (kind === "allow") return paths.real !== undefined && segmentsMatch(canonical, paths.real);
		return segmentsMatch(raw, paths.target) || (paths.real !== undefined && segmentsMatch(canonical, paths.real));
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

/** Splits a list into the rules lunR reads and those past `MAX_RULES` or `MAX_RULE_LENGTH`. */
function capRules(list: readonly unknown[]): { kept: string[]; dropped: string[] } {
	const strings = list.filter((source): source is string => typeof source === "string");
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const source of strings) {
		if (kept.length < MAX_RULES && source.length <= MAX_RULE_LENGTH) kept.push(source);
		else dropped.push(source);
	}
	return { kept, dropped };
}

/** The tool a rule names, read even from a rule too long to compile. */
function ruleTool(source: string): string | undefined {
	return /^\s*([A-Za-z0-9_.:-]+)/.exec(source)?.[1]?.toLowerCase();
}

/** Settings-load warnings for rules that would never match or that a cap drops, one per rule. */
export function permissionRuleProblems(list: unknown, name: string): string[] {
	if (list === undefined) return [];
	if (!Array.isArray(list)) return [`${name} must be a list of rules such as "bash(npm test)"; it is ignored.`];
	const deny = name.endsWith("deny");
	const { dropped } = capRules(list);
	const cap = dropped.map((source) => {
		const label = source.length > 60 ? `${source.slice(0, 60)}…` : source;
		const why =
			source.length > MAX_RULE_LENGTH
				? `is over ${MAX_RULE_LENGTH} characters`
				: `is past the first ${MAX_RULES} rules`;
		return deny
			? `${name} has "${label}", which ${why}. lunR blocks every ${ruleTool(source) ?? "matching"} call until you shorten or remove it.`
			: `${name} has "${label}", which ${why}; it is ignored.`;
	});
	const kept = new Set(capRules(list).kept);
	return [
		...list.flatMap((source): string[] => {
			if (typeof source !== "string")
				return [`${name} has ${JSON.stringify(source)}, which is not a rule; it is ignored.`];
			if (!kept.has(source)) return [];
			const parsed = parsePermissionRule(source);
			if (!parsed) return [`${name} has "${source}", which is not tool or tool(pattern); it is ignored.`];
			if (parsed.pattern && parsed.tool !== "bash" && !PATH_TOOLS.has(parsed.tool)) {
				return [
					`${name} has "${source}", but ${parsed.tool} rules take no pattern, so it never matches. Write "${parsed.tool}".`,
				];
			}
			return [];
		}),
		...cap,
	];
}

function compileRule(source: string, cwd: string, kind: "allow" | "deny"): [string, CompiledRule] | undefined {
	const parsed = parsePermissionRule(source);
	if (!parsed) return undefined;
	if (!parsed.pattern) return [parsed.tool, { source }];
	if (parsed.tool === "bash") return [parsed.tool, { source, matches: bashMatcher(parsed.pattern, kind) }];
	if (PATH_TOOLS.has(parsed.tool)) return [parsed.tool, { source, matches: pathMatcher(parsed.pattern, cwd, kind) }];
	return [parsed.tool, { source, matches: () => false }];
}

function compileList(lists: readonly unknown[][], cwd: string, kind: "allow" | "deny"): Map<string, CompiledRule[]> {
	const byTool = new Map<string, CompiledRule[]>();
	const add = (tool: string, rule: CompiledRule) => byTool.set(tool, [...(byTool.get(tool) ?? []), rule]);
	for (const list of lists) {
		const { kept, dropped } = capRules(list);
		for (const source of kept) {
			const compiled = compileRule(source, cwd, kind);
			if (compiled) add(...compiled);
		}
		// A deny rule lunR can't read blocks every call of its tool rather than nothing.
		if (kind === "deny") {
			for (const source of dropped) {
				const tool = ruleTool(source);
				if (tool) add(tool, { source });
			}
		}
	}
	return byTool;
}

function callView(input: Record<string, unknown>, cwd: string): CallView {
	let lines: DeniedLine[] | undefined;
	let paths: { target: string[]; real: string[] | undefined } | undefined | null = null;
	const command = () => (typeof input.command === "string" ? input.command.trim() : undefined);
	return {
		command,
		deniedLines: () => {
			lines ??= deniedCommandLines(command() ?? "");
			return lines;
		},
		paths: () => {
			if (paths === null) {
				const target = typeof input.path === "string" && input.path ? resolveToCwd(input.path, cwd) : undefined;
				const real = target === undefined ? undefined : safeCanonical(target);
				paths =
					target === undefined
						? undefined
						: { target: pathSegments(target), real: real === undefined ? undefined : pathSegments(real) };
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

function asList(value: unknown): unknown[] {
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
	const allow = compileList([asList(global?.allow), projectTrusted ? asList(project?.allow) : []], cwd, "allow");
	const deny = compileList([asList(global?.deny), asList(project?.deny)], cwd, "deny");
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
