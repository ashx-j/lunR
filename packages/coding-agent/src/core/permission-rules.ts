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
 * Matching is linear in the command for each rule (see `denyMatches`), and `MAX_RULES` /
 * `MAX_RULE_LENGTH` cap each list. A deny rule past a cap still blocks every call of its tool, so
 * dropping it fails closed, and settings load warns about it.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { type DeniedCommands, type DeniedLine, deniedCommandLines } from "./permission-rule-commands.ts";
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
	deniedLines(): DeniedCommands;
	/** The resolved path and its real location as segments, for path rules. */
	paths(): { target: string[]; real: string[] | undefined } | undefined;
}

type Matcher = (call: CallView) => boolean;

interface CompiledRule {
	source: string;
	matches?: Matcher;
}

export interface DenyMatch {
	rule: string;
	/** The bash command nests too deeply or costs too much to check, so every bash deny rule matches it. */
	uncheckable: boolean;
}

export interface CompiledPermissionRules {
	/** The first deny rule matching this call, if any, as a label of at most 60 characters. */
	denied(toolName: string, input: Record<string, unknown>): DenyMatch | undefined;
	/** True when an allow rule matches this call. */
	allowed(toolName: string, input: Record<string, unknown>): boolean;
}

const RULE_SYNTAX = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/s;
/** Shell characters that chain, redirect or expand; an allow rule never matches a command with one. */
const SHELL_CONTROL = /[;&|<>$`()\n\r\\]/;
const SHORT_FLAGS = /^-[A-Za-z]+$/;

/** True when `text` matches the glob split on `*` into `pieces`. Greedy piece search, so it never backtracks. */
function globMatch(pieces: readonly string[], text: string): boolean {
	if (pieces.length === 1) return pieces[0] === text;
	const first = pieces[0];
	const last = pieces[pieces.length - 1];
	if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
	let at = first.length;
	const end = text.length - last.length;
	for (let k = 1; k < pieces.length - 1; k++) {
		const found = text.indexOf(pieces[k], at);
		if (found === -1 || found + pieces[k].length > end) return false;
		at = found + pieces[k].length;
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

/** Short flags as bit sets: `lower` for a to z, `upper` for A to Z. */
interface FlagSet {
	lower: number;
	upper: number;
}

/** `plain`: the glob can't match an option word (it starts with neither `-` nor `*`). */
type PatternWord = { kind: "glob"; pieces: string[]; plain: boolean } | ({ kind: "flags" } & FlagSet);

interface DenyPattern {
	/** The command word's glob, split on `*`. */
	name: string[];
	/** The words after the command word. */
	words: PatternWord[];
	/**
	 * A starred last word (`push*`, `/*`), a glob over the rest of the line: `first` starts a word and
	 * `middle` are the pieces between its stars. The pieces hold no spaces, so each lies inside one word.
	 */
	tail?: { first: string; middle: string[]; plain: boolean };
	/** A starred lone command word or last flag word (`sudo*`, `-rf*`): any text may follow. */
	restAllowed: boolean;
}

function flagSet(word: string): FlagSet {
	const set = { lower: 0, upper: 0 };
	for (let i = 1; i < word.length; i++) {
		const code = word.charCodeAt(i);
		if (code >= 97) set.lower |= 1 << (code - 97);
		else set.upper |= 1 << (code - 65);
	}
	return set;
}

function patternWord(word: string): PatternWord {
	return SHORT_FLAGS.test(word) && word.length > 2
		? { kind: "flags", ...flagSet(word) }
		: { kind: "glob", pieces: word.split("*"), plain: !/^[-*]/.test(word) };
}

const PLAIN = 0;
const OPTION = 1;
/** An option with `=`, so the word after it is not its value. */
const VALUED_OPTION = 2;
const SHORT_FLAG_WORD = 3;

function wordKind(word: string): number {
	if (!word.startsWith("-")) return PLAIN;
	return word.includes("=") ? VALUED_OPTION : SHORT_FLAGS.test(word) ? SHORT_FLAG_WORD : OPTION;
}

/** A line longer than this gets `factsOf`; a shorter one is cheaper to read word by word. */
const LONG_LINE = 32;

/** Each word's kind and short flags, computed once per long segment's words and shared by every rule. */
const wordFacts = new WeakMap<
	readonly string[],
	{ kind: number[]; lower: number[]; upper: number[]; nextPlain: number[] }
>();

function factsOf(words: readonly string[]) {
	let facts = wordFacts.get(words);
	if (!facts) {
		facts = {
			kind: words.map(wordKind),
			lower: new Array<number>(words.length).fill(0),
			upper: new Array<number>(words.length).fill(0),
			/** Index of the first plain word at or after each index. */
			nextPlain: new Array<number>(words.length + 1),
		};
		for (let i = 0; i < words.length; i++) {
			if (facts.kind[i] !== SHORT_FLAG_WORD) continue;
			const set = flagSet(words[i]);
			facts.lower[i] = set.lower;
			facts.upper[i] = set.upper;
		}
		facts.nextPlain[words.length] = words.length;
		for (let i = words.length - 1; i >= 0; i--)
			facts.nextPlain[i] = facts.kind[i] === PLAIN ? i : facts.nextPlain[i + 1];
		wordFacts.set(words, facts);
	}
	return facts;
}

function compileDenyPattern(pattern: string): DenyPattern {
	const [command, ...words] = pattern.split(/\s+/);
	const name = command.split("*");
	const last = words.pop();
	if (last === undefined) return { name, words: [], restAllowed: command.endsWith("*") };
	const starred = last.endsWith("*");
	const flags = last.slice(0, -1);
	if (!starred || (SHORT_FLAGS.test(flags) && flags.length > 2)) {
		return { name, words: [...words, starred ? flags : last].map(patternWord), restAllowed: starred };
	}
	const [first, ...rest] = last.split("*");
	return {
		name,
		words: words.map(patternWord),
		tail: { first, middle: rest.filter(Boolean), plain: !/^[-*]/.test(last) },
		restAllowed: false,
	};
}

/** True when `pieces` occur in order in `words[w]` (from character `at`) up to `words[end - 1]`. */
function piecesFrom(pieces: readonly string[], words: readonly string[], w: number, at: number, end: number): boolean {
	let k = 0;
	while (k < pieces.length && w < end) {
		const found = words[w].indexOf(pieces[k], at);
		if (found === -1) {
			w++;
			at = 0;
		} else {
			at = found + pieces[k].length;
			k++;
		}
	}
	return k === pieces.length;
}

/**
 * One deny pattern against one line in a single forward pass, so O(line length). The command word
 * matches the pattern's first word, then each later pattern word matches the next word not skipped:
 * an option word may be skipped, and one plain word after it as its value (`git -C repo push`). A
 * word that matches the current pattern word is always taken, so `git -C push push` is missed, which
 * is fine for a guard against accidents. A flag word takes a run of short-flag words that together
 * hold its flags (`-rf` matches `-r -f`).
 */
function denyLineMatch(pattern: DenyPattern, line: DeniedLine, budget: { left: number }): boolean {
	budget.left--;
	if (!line.wildcard && !globMatch(pattern.name, line.name)) return false;
	const { words, end } = line;
	const facts = end - line.start > LONG_LINE ? factsOf(words) : undefined;
	const { tail } = pattern;
	let p = 0;
	let afterOption = false;
	let matched = false;
	let w = line.start + 1;
	for (; ; w++) {
		const want = pattern.words[p];
		const plain = want === undefined ? tail?.plain : want.kind === "glob" && want.plain;
		if (facts && plain && w < end && facts.kind[w] !== PLAIN) {
			// Nothing in a run of options can match, so jump over it; the word after may be its value.
			w = facts.nextPlain[w];
			afterOption = facts.kind[w - 1] !== VALUED_OPTION;
		}
		if (want === undefined) {
			if (pattern.restAllowed || (!tail && w === end)) {
				matched = true;
				break;
			}
			if (tail && w === end) {
				matched = tail.first === "" && tail.middle.length === 0;
				break;
			}
			// Later pieces only get harder to find further on, so the first word that starts the tail settles it.
			if (tail && words[w].startsWith(tail.first)) {
				matched = piecesFrom(tail.middle, words, w, tail.first.length, end);
				w = end;
				break;
			}
		} else if (
			w < end &&
			want.kind === "glob" &&
			(want.pieces.length === 1 ? words[w] === want.pieces[0] : globMatch(want.pieces, words[w]))
		) {
			p++;
			afterOption = false;
			continue;
		} else if (w < end && want.kind === "flags") {
			// A run of short-flag words; a later start inside it holds fewer flags, so take or skip all of it.
			let seenLower = 0;
			let seenUpper = 0;
			let k = w;
			for (; k < end && (facts ? facts.kind[k] : wordKind(words[k])) === SHORT_FLAG_WORD; k++) {
				if (facts) {
					seenLower |= facts.lower[k];
					seenUpper |= facts.upper[k];
				} else {
					const set = flagSet(words[k]);
					seenLower |= set.lower;
					seenUpper |= set.upper;
				}
				if ((seenLower & want.lower) === want.lower && (seenUpper & want.upper) === want.upper) {
					k++;
					break;
				}
			}
			const covered = (seenLower & want.lower) === want.lower && (seenUpper & want.upper) === want.upper;
			if (k > w) {
				if (covered) p++;
				afterOption = !covered;
				w = k - 1;
				continue;
			}
		}
		if (w >= end) break;
		const kind = facts ? facts.kind[w] : wordKind(words[w]);
		if (kind !== PLAIN) afterOption = kind !== VALUED_OPTION;
		else if (afterOption) afterOption = false;
		else break;
	}
	budget.left -= w - line.start;
	return matched;
}

/** Work units per input character and rule. The costliest realistic command measured 0.35 (a 325-line script through `bash -c`). */
const WORK_PER_CHARACTER_RULE = 4;

/**
 * The work units one bash call may spend on deny rules: characters scanned plus words visited, by
 * `deniedCommandLines` and every rule's `denyLineMatch`. Past it the call fails closed as too complex,
 * so no input can hang or exhaust memory, whatever its shape.
 */
export function denyWorkBudget(length: number, rules: number): number {
	return WORK_PER_CHARACTER_RULE * (length + 256) * (rules + 1);
}

/**
 * True when `pattern` matches one of the lines, or the check is `uncheckable`. Costs at most
 * (command length) x (number of deny rules) x a constant, and the budget enforces that: the lines
 * hold at most (MAX_DEPTH + 1) x the input, `MAX_STAGES` lines per segment, and `denyLineMatch`
 * makes one forward pass per line. A rule whose command word names no line skips them all.
 */
function denyMatches(pattern: DenyPattern, commands: DeniedCommands): boolean {
	const literal = pattern.name.length === 1 ? pattern.name[0] : undefined;
	// With many lines, a rule whose literal command word names none of them skips them all.
	if (literal !== undefined && commands.lines.length > 16 && !commands.wildcard) {
		commands.names ??= new Set(commands.lines.map((line) => line.name));
		if (!commands.names.has(literal)) return commands.uncheckable;
	}
	if (!commands.uncheckable) {
		for (const line of commands.lines) {
			if (commands.left < 0) break;
			if (denyLineMatch(pattern, line, commands)) return true;
		}
	}
	if (commands.left < 0) commands.uncheckable = true;
	return commands.uncheckable;
}

/** The work a bash command costs against deny patterns (`git push*`, without `bash(...)`); for tests. */
export function bashDenyWork(patterns: readonly string[], command: string): { used: number; limit: number } {
	const compiled = patterns.map(compileDenyPattern);
	const limit = denyWorkBudget(command.length, compiled.length);
	const commands = deniedCommandLines(command, limit);
	for (const pattern of compiled) denyMatches(pattern, commands);
	return { used: limit - commands.left, limit };
}

function bashMatcher(pattern: string, kind: "allow" | "deny"): Matcher {
	if (kind === "allow") {
		const pieces = pattern.split("*");
		return (call) => {
			const command = call.command();
			return command !== undefined && !SHELL_CONTROL.test(command) && globMatch(pieces, command);
		};
	}
	const compiled = compileDenyPattern(pattern);
	return (call) => denyMatches(compiled, call.deniedLines());
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

function ruleLabel(source: string): string {
	return source.length > 60 ? `${source.slice(0, 60)}…` : source;
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
		const label = ruleLabel(source);
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
	// A rule listed twice would only be matched twice.
	const seen = new Set<string>();
	for (const list of lists) {
		const { kept, dropped } = capRules(list);
		for (const source of kept) {
			if (seen.has(source)) continue;
			seen.add(source);
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

function callView(input: Record<string, unknown>, cwd: string, bashDenyRules: number): CallView {
	let lines: DeniedCommands | undefined;
	let paths: { target: string[]; real: string[] | undefined } | undefined | null = null;
	const command = () => (typeof input.command === "string" ? input.command.trim() : undefined);
	return {
		command,
		deniedLines: () => {
			const text = command() ?? "";
			lines ??= deniedCommandLines(text, denyWorkBudget(text.length, bashDenyRules));
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
	const bashDenyRules = deny.get("bash")?.filter((rule) => rule.matches).length ?? 0;
	// The gate asks deny, then allow, about the same arguments object; both share one view of it.
	const views = new WeakMap<Record<string, unknown>, CallView>();
	const view = (input: Record<string, unknown>) => () => {
		let call = views.get(input);
		if (!call) {
			call = callView(input, cwd, bashDenyRules);
			views.set(input, call);
		}
		return call;
	};
	const rules: CompiledPermissionRules = {
		denied: (toolName, input) => {
			const rule = firstMatch(deny, toolName, view(input));
			if (!rule) return undefined;
			const uncheckable = rule.matches !== undefined && view(input)().deniedLines().uncheckable;
			return { rule: ruleLabel(rule.source), uncheckable };
		},
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
