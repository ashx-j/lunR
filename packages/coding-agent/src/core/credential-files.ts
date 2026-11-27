import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/**
 * Keeps lunR's own saved logins in the active profile out of tool calls: `auth.json` (API keys and
 * OAuth tokens), `subscriptions.json` and the `mcp-oauth/` tree.
 * - `gateToolCall` runs `credentialArgsReason` on every tool call, so built-in, extension and MCP
 *   tools all refuse an argument that resolves to one of them, and `credentialBashReason` on bash.
 * - lunR's recursive tools skip them inside a directory they walk (`credentialWalkFilter`), and
 *   the read tool refuses a symlink to one under another name (`credentialFileReason`).
 * lunR's own code (login, `lunr doctor`) reads them directly and never passes through here. This
 * guards against an accidental or injected read. It is not a sandbox: see docs/security.md.
 */

// Tells the model how to get a value it needs, since the file itself stays closed.
export const CREDENTIAL_SHARE_HINT = "If you need a specific value, ask the user to share it.";
export const CREDENTIAL_BLOCK_REASON = `This path holds lunR's saved logins (API keys and OAuth tokens), so tools do not use it. ${CREDENTIAL_SHARE_HINT}`;
export const CREDENTIAL_SKIP_NOTE = `[Skipped lunR's saved logins (auth.json, subscriptions.json, mcp-oauth/). ${CREDENTIAL_SHARE_HINT}]`;

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const CREDENTIAL_NAMES = ["auth.json", "subscriptions.json", "mcp-oauth"];
// Regexes here are built only from these constant names and the profile path, never from tool input.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]-]/g, "\\$&");
const CREDENTIAL_NAME = new RegExp(CREDENTIAL_NAMES.map(escapeRegExp).join("|"), CASE_INSENSITIVE ? "i" : "");
// Deep enough for an MCP proxy's `args` object or a list of edits; tool inputs rarely nest further.
const MAX_ARG_DEPTH = 3;

function fold(path: string): string {
	return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

interface CredentialPaths {
	dir: string;
	auth: string;
	subscriptions: string;
	mcp: string;
}

function credentialPathsIn(agentDir: string): CredentialPaths {
	const dir = fold(resolve(agentDir));
	return {
		dir,
		auth: join(dir, "auth.json"),
		subscriptions: join(dir, "subscriptions.json"),
		mcp: join(dir, "mcp-oauth"),
	};
}

// Keyed by the raw agent dir string, so a changed PI_CODING_AGENT_DIR rebuilds it.
let profilePaths: { agentDir: string; paths: CredentialPaths } | undefined;

function activeCredentialPaths(): CredentialPaths {
	const agentDir = getAgentDir();
	if (profilePaths?.agentDir !== agentDir) profilePaths = { agentDir, paths: credentialPathsIn(agentDir) };
	lastProfileDir = profilePaths.paths.dir;
	return profilePaths.paths;
}

function canonicalCredentialPaths(): CredentialPaths {
	return credentialPathsIn(canonicalizeTargetPath(getAgentDir()));
}

/** `target` must be absolute, normalized and folded. */
function matchesCredential(target: string, paths: CredentialPaths): boolean {
	return (
		target === paths.auth ||
		target === paths.subscriptions ||
		target === paths.mcp ||
		target.startsWith(paths.mcp + sep)
	);
}

function isWithin(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The refusal when `value` resolves (relative to `cwd`, through symlinks) to a credential location. */
function credentialPathReason(value: string, cwd: string): string | undefined {
	try {
		const target = resolveToCwd(value.startsWith("file://") ? fileURLToPath(value) : value, cwd);
		if (matchesCredential(fold(target), activeCredentialPaths())) return CREDENTIAL_BLOCK_REASON;
		return matchesCredential(fold(canonicalizeTargetPath(target)), canonicalCredentialPaths())
			? CREDENTIAL_BLOCK_REASON
			: undefined;
	} catch {
		// A bad file URL, a dangling link or an unreadable ancestor names nothing readable.
		return undefined;
	}
}

// getAgentDir() reads process.env (~0.5 µs), too slow for every tool call, so the fast test uses
// the profile dir from the last lookup. The agent dir is fixed for a process outside tests, and a
// stale value only skips this extra trigger: names still match and the slow path re-reads it.
let lastProfileDir: string | undefined;

/**
 * The fast test, about 50 ns for a path and 0.8 ns per character of longer text. No length cap:
 * `x/../` padding makes any path long, and the tools resolve it lexically.
 */
function mayNameCredential(value: string): boolean {
	if (CREDENTIAL_NAME.test(value)) return true;
	lastProfileDir ??= activeCredentialPaths().dir;
	return fold(value).includes(lastProfileDir);
}

function scanArgs(value: unknown, cwd: string, depth: number): string | undefined {
	if (typeof value === "string") return mayNameCredential(value) ? credentialPathReason(value, cwd) : undefined;
	if (depth >= MAX_ARG_DEPTH || value === null || typeof value !== "object") return undefined;
	for (const item of Array.isArray(value) ? value : Object.values(value)) {
		const reason = scanArgs(item, cwd, depth + 1);
		if (reason) return reason;
	}
	return undefined;
}

/**
 * The refusal when any string argument of a tool call, or one inside an array or object argument,
 * resolves to a credential location. A call whose strings name none of the 3 locations and not the
 * profile directory costs one regex and one substring test per string, with no fs access.
 */
export function credentialArgsReason(input: Record<string, unknown>, cwd: string): string | undefined {
	return scanArgs(input, cwd, 0);
}

// The names with quotes, backslashes or line continuations between characters: what is left of a
// name once bash removes them (`"auth".json`, `a''uth.json`, `auth\.json`).
const LOOSE_CREDENTIAL_NAME = new RegExp(
	CREDENTIAL_NAMES.map((name) => [...name].map(escapeRegExp).join(`['"\\\\\\n]*`)).join("|"),
	CASE_INSENSITIVE ? "i" : "",
);
// The same names, searched from a position: a heredoc body without one is skipped whole.
const LOOSE_CREDENTIAL_NAME_FROM = new RegExp(LOOSE_CREDENTIAL_NAME.source, `${LOOSE_CREDENTIAL_NAME.flags}g`);
const GLOB_CHARS = /[*?[]/;

let reportedBashFailure = false;

/**
 * The refusal when a bash command names a credential location. Matched, and nothing else:
 * - literal words and `--opt=` values, after removing quotes, `\` escapes and line continuations;
 * - `$HOME`, `"$HOME"` and `${HOME}` (and `$USERPROFILE` on Windows), from lunR's own environment;
 * - paths relative to a `cd`, `cd --`, `cd -L`/`-P` or `pushd` with a single directory (redirections
 *   such as `>/dev/null` ignored), undone by `popd`;
 * - unquoted globs (`*`, `?`, any `[...]` as 1 character) whose literal part reaches the profile's
 *   parent directory and whose remaining segments match a guarded path segment by segment.
 * Not followed: brace expansion, `$'...'`, `${HOME:-x}` and other parameter forms, other variables,
 * assignments, command substitution, `bash -c`, `eval`, `cd -`, `CDPATH`, `~+`, shell options such
 * as `extglob`, and symlinks a `cd` passes through. This is a guard for 3 file names, not a sandbox.
 *
 * Commands with no name (even split by quotes) and no glob near the profile return after 2 text
 * scans. Any internal error allows the command: a wrong refusal blocks normal work.
 */
export function credentialBashReason(command: string, cwd: string): string | undefined {
	try {
		return bashReason(command, cwd);
	} catch (error) {
		if (!reportedBashFailure) {
			reportedBashFailure = true;
			console.error(`lunR: the saved-login check failed on a bash command and allowed it: ${String(error)}`);
		}
		return undefined;
	}
}

function bashReason(command: string, cwd: string): string | undefined {
	const names = LOOSE_CREDENTIAL_NAME.test(command);
	const globs = globsMayReachProfile(command, cwd) && GLOB_CHARS.test(command);
	if (!names && !globs) return undefined;
	const resolved = new Map<string, boolean>();
	const namesCredential = (candidate: string, base: string) => {
		const key = `${base}\0${candidate}`;
		let hit = resolved.get(key);
		if (hit === undefined) {
			hit = credentialPathReason(candidate, base) !== undefined;
			resolved.set(key, hit);
		}
		return hit;
	};
	let base = cwd;
	const pushed: string[] = [];
	for (const segment of bashSegments(command, names)) {
		const first = segment[0]?.text;
		if (first === "cd" || first === "pushd") {
			const target = directoryArgument(segment);
			if (target !== undefined) {
				if (first === "pushd") pushed.push(base);
				base = resolveToCwd(fromMsysPath(target), base);
			}
			continue;
		}
		if (first === "popd") {
			base = pushed.pop() ?? base;
			continue;
		}
		// After `cd .../mcp-oauth/x` a plain word such as `tokens.json` can name a guarded file.
		const baseNamed = base !== cwd && CREDENTIAL_NAME.test(base);
		for (const word of segment) {
			if (baseNamed || CREDENTIAL_NAME.test(word.text)) {
				const text = fromMsysPath(word.text);
				const eq = text.lastIndexOf("=");
				for (const candidate of eq === -1 ? [text] : [text, fromMsysPath(text.slice(eq + 1))]) {
					const named = CREDENTIAL_NAME.test(candidate) || (baseNamed && !word.body && !/\s/.test(candidate));
					if (candidate && named && namesCredential(candidate, base)) return CREDENTIAL_BLOCK_REASON;
				}
			}
			if (globs && word.globs && globNamesCredential(word.text, word.globs, base)) return CREDENTIAL_BLOCK_REASON;
		}
	}
	return undefined;
}

/**
 * Whether an unquoted glob could reach a guarded path: the text names the profile's parent
 * directory (`.lunr` for `~/.lunr/agent`), or the cwd is inside it. Like `mayNameCredential`, this
 * uses the profile dir from the last lookup, because `getAgentDir()` costs about 0.6 µs.
 */
function globsMayReachProfile(command: string, cwd: string): boolean {
	const context = profileContext();
	if (CASE_INSENSITIVE ? context.marker.test(command) : command.includes(context.name)) return true;
	if (context.cwd !== cwd) {
		context.cwd = cwd;
		context.cwdInside = isWithin(fold(resolve(cwd)), context.parent);
	}
	return context.cwdInside;
}

let profileContextCache:
	| { dir: string; parent: string; name: string; marker: RegExp; cwd?: string; cwdInside: boolean }
	| undefined;

function profileContext(): NonNullable<typeof profileContextCache> {
	const dir = lastProfileDir ?? activeCredentialPaths().dir;
	if (profileContextCache?.dir !== dir) {
		const parent = dirname(dir);
		const name = basename(parent) || basename(dir);
		profileContextCache = {
			dir,
			parent,
			name,
			marker: new RegExp(escapeRegExp(name), CASE_INSENSITIVE ? "i" : ""),
			cwdInside: false,
		};
	}
	return profileContextCache;
}

/** The single directory of a `cd` or `pushd` segment, without redirections and `-L`/`-P`/`-e`/`-@`. */
function directoryArgument(segment: BashWord[]): string | undefined {
	const args = segment.slice(1).filter((word) => !word.redirect);
	let index = 0;
	while (index < args.length && /^-[LPe@]+$/.test(args[index].text)) index++;
	if (args[index]?.text === "--") index++;
	const rest = args.slice(index);
	return rest.length === 1 && rest[0].text !== "-" ? rest[0].text : undefined;
}

/**
 * Bash on Windows names drive `C:` as `/c` (Git Bash, MSYS2), `/cygdrive/c` (Cygwin) or `/mnt/c`
 * (WSL), so `/c/Users/me` is `C:/Users/me` there. `/c` alone is the drive's root, not `C:`, which
 * Node reads as the current directory on that drive.
 */
function fromMsysPath(word: string): string {
	return process.platform === "win32" ? word.replace(/^(?:\/cygdrive|\/mnt)?\/([a-z])(?=\/|$)/i, "$1:/") : word;
}

// Pattern codes for an unquoted `*` and for `?` or a bracket expression; other entries are char codes.
const STAR = -1;
const ONE = -2;

/** An unquoted glob character or bracket expression in a word: `[start, end)` of the word's text. */
interface GlobToken {
	start: number;
	end: number;
	code: typeof STAR | typeof ONE;
}

/**
 * Whether glob word `text` (relative to `base`) can match a credential file, or the `mcp-oauth`
 * tree or something in it. The literal part before the segment with the first glob is resolved
 * lexically; the rest is matched segment by segment with `segmentMatches`.
 */
function globNamesCredential(text: string, tokens: GlobToken[], base: string): boolean {
	const headEnd = text.lastIndexOf("/", tokens[0].start) + 1;
	const dir = headEnd === 0 ? resolvedBase(base) : fold(resolveToCwd(fromMsysPath(text.slice(0, headEnd)), base));
	const paths = activeCredentialPaths();
	const inTree = under(dir, paths.mcp);
	if (!inTree && !under(paths.dir, dir)) return false;
	const segments: number[][] = [[]];
	let token = 0;
	for (let i = headEnd; i < text.length; i++) {
		if (token < tokens.length && tokens[token].start === i) {
			segments[segments.length - 1].push(tokens[token].code);
			i = tokens[token++].end - 1;
		} else if (text[i] === "/") segments.push([]);
		else segments[segments.length - 1].push(fold(text[i]).charCodeAt(0));
	}
	const pattern = segments.filter((part) => part.length > 0 && !(part.length === 1 && part[0] === 46));
	// `..` after a glob: refuse rather than follow it, since the glob is next to the profile.
	if (pattern.some((part) => part.length === 2 && part[0] === 46 && part[1] === 46)) return true;
	if (inTree) return pattern.length > 0;
	const covers = (location: string, tree: boolean) => {
		if (!under(location, dir)) return false;
		const parts = location.slice(dir.endsWith(sep) ? dir.length : dir.length + 1).split(sep);
		if (tree ? pattern.length < parts.length : pattern.length !== parts.length) return false;
		return parts.every((part, index) => segmentMatches(pattern[index], part));
	};
	return covers(paths.auth, false) || covers(paths.subscriptions, false) || covers(paths.mcp, true);
}

// Node's path functions cost 1 to 4 µs a call; these paths are already absolute and normalized.
/** Whether absolute, normalized `target` is `root` or inside it. */
function under(target: string, root: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

let lastBase: { base: string; resolved: string } | undefined;

/** `base` resolved and folded, cached for the cwd that every glob word without a directory uses. */
function resolvedBase(base: string): string {
	if (lastBase?.base !== base) lastBase = { base, resolved: fold(resolve(base)) };
	return lastBase.resolved;
}

/**
 * Linear wildcard match of one pattern segment against one path segment, with a single fallback
 * point for the last `*` (no backtracking beyond it). A leading glob does not match a leading `.`.
 */
function segmentMatches(pattern: number[], name: string): boolean {
	if (name.startsWith(".") && pattern[0] < 0) return false;
	let fixed = 0;
	for (const code of pattern) if (code !== STAR) fixed++;
	if (fixed > name.length) return false;
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < name.length) {
		if (p < pattern.length && (pattern[p] === ONE || pattern[p] === name.charCodeAt(n))) {
			p++;
			n++;
		} else if (p < pattern.length && pattern[p] === STAR) {
			star = p++;
			mark = n;
		} else if (star !== -1) {
			p = star + 1;
			n = ++mark;
		} else return false;
	}
	while (p < pattern.length && pattern[p] === STAR) p++;
	return p === pattern.length;
}

interface BashWord {
	text: string;
	/** Unquoted glob characters, in order; only outside heredoc bodies. */
	globs?: GlobToken[];
	/** The target of a redirection (`>/dev/null`, `<<< x`). */
	redirect?: boolean;
	/** A line of a heredoc body. */
	body?: boolean;
}

// Inside double quotes bash keeps a backslash unless it escapes one of these, so a quoted Windows
// path such as "C:\Users\me\auth.json" keeps its separators.
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
const HOME_NAMES = process.platform === "win32" ? ["HOME", "USERPROFILE"] : ["HOME"];
const BREAKS = new Set([" ", "\t", "\n", ";", "|", "&", "<", ">", "(", ")", "`", "'", '"', "\\"]);
// Characters the tokenizer acts on outside quotes; any other character is copied as it is.
const SPECIAL = new Set([...BREAKS, "$", "*", "?", "["]);

/** The value bash gives a home variable: lunR's environment, or the home directory for an unset HOME. */
function homeVariable(name: string): string | undefined {
	return process.env[name] ?? (name === "HOME" ? homedir() : undefined);
}

/** `$NAME` or `${NAME}` for a home variable at `i`: its length and value. */
function homeVariableAt(command: string, i: number): { length: number; value: string } | undefined {
	for (const name of HOME_NAMES) {
		const braced = command.startsWith(`\${${name}}`, i);
		const bare = !braced && command.startsWith(`$${name}`, i) && !/\w/.test(command[i + name.length + 1] ?? "");
		const value = braced || bare ? homeVariable(name) : undefined;
		if (value !== undefined) return { length: name.length + (braced ? 3 : 1), value };
	}
	return undefined;
}

/**
 * Bash words grouped by `;`, `|`, `&` and newline, in one pass over the text (`hasName`: the text has
 * a loose name, else heredoc bodies are skipped without a search): quotes, `\` escapes and
 * line continuations removed, home variables expanded, unquoted globs and redirection targets marked,
 * and heredoc bodies kept as words of their own (quotes there end at each line, globs not marked).
 */
function bashSegments(command: string, hasName: boolean): BashWord[][] {
	const segments: BashWord[][] = [[]];
	let word = "";
	let tokens: GlobToken[] | undefined;
	let redirect = false;
	let heredocDelimiter: "plain" | "strip" | undefined;
	const heredocs: Array<{ delimiter: string; strip: boolean }> = [];
	let quote: "'" | '"' | undefined;
	let bodyEnd = -1;
	let resumeAt = -1;
	let bracketFailsBefore = -1;
	const newSegment = () => {
		if (segments[segments.length - 1].length > 0) segments.push([]);
	};
	const endWord = () => {
		if (!word) return;
		if (heredocDelimiter) heredocs.push({ delimiter: word, strip: heredocDelimiter === "strip" });
		else segments[segments.length - 1].push({ text: word, globs: tokens, redirect, body: bodyEnd !== -1 });
		// A redirection or heredoc operator applies to the next word, also after a space (`<< 'EOF'`).
		redirect = false;
		heredocDelimiter = undefined;
		word = "";
		tokens = undefined;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (bodyEnd !== -1 && i >= bodyEnd) {
			endWord();
			newSegment();
			quote = undefined;
			bodyEnd = -1;
			i = resumeAt - 1;
			continue;
		}
		const inBody = bodyEnd !== -1;
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			if (command[i + 1] === "\n") i++;
			else if (quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(command[i + 1])) word += ch;
			else word += command[++i];
		} else if (ch === "$" && quote !== "'") {
			const home = homeVariableAt(command, i);
			if (home) {
				word += home.value;
				i += home.length - 1;
			} else word += ch;
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "\n" && inBody) {
				quote = undefined;
				endWord();
				newSegment();
			} else if (!inBody) {
				// Take the quoted run up to the next character that changes something in one slice.
				let end = i + 1;
				if (quote === "'") end = command.indexOf("'", i);
				else
					while (end < command.length && command[end] !== '"' && command[end] !== "\\" && command[end] !== "$")
						end++;
				if (end === -1) end = command.length;
				word += command.slice(i, end);
				i = end - 1;
			} else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "&" && command[i + 1] === ">" && !inBody) {
			endWord();
		} else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			endWord();
			newSegment();
			redirect = false;
			heredocDelimiter = undefined;
			if (ch === "\n" && !inBody && heredocs.length > 0) {
				const span = heredocSpan(command, i + 1, heredocs.splice(0));
				LOOSE_CREDENTIAL_NAME_FROM.lastIndex = i + 1;
				const name = hasName ? LOOSE_CREDENTIAL_NAME_FROM.exec(command) : null;
				// A body is data on stdin: only a name in it can matter, so a body without one is skipped.
				if (name && name.index < span.bodyEnd) bodyEnd = span.bodyEnd;
				else i = span.resumeAt - 1;
				resumeAt = span.resumeAt;
			}
		} else if ((ch === "<" || ch === ">") && !inBody) {
			if (/^\d+$/.test(word)) word = "";
			endWord();
			let end = i + 1;
			while (end < command.length && (command[end] === "<" || command[end] === ">" || command[end] === "&")) end++;
			const operator = command.slice(i, end);
			if (operator === "<<" && command[end] === "-") {
				heredocDelimiter = "strip";
				end++;
			} else if (operator === "<<") heredocDelimiter = "plain";
			else redirect = true;
			i = end - 1;
		} else if (ch === " " || ch === "\t" || ch === "(" || ch === ")" || ch === "`" || ch === "<" || ch === ">") {
			endWord();
		} else if ((ch === "*" || ch === "?") && !inBody) {
			tokens ??= [];
			tokens.push({ start: word.length, end: word.length + 1, code: ch === "*" ? STAR : ONE });
			word += ch;
		} else if (ch === "[" && !inBody && i >= bracketFailsBefore) {
			const close = bracketEnd(command, i);
			if ("failedAt" in close) {
				bracketFailsBefore = close.failedAt;
				word += ch;
			} else {
				tokens ??= [];
				tokens.push({ start: word.length, end: word.length + close.end + 1 - i, code: ONE });
				word += command.slice(i, close.end + 1);
				i = close.end;
			}
		} else {
			// Take the run of characters that change nothing in one slice, stopping at a body's end.
			let end = i + 1;
			while (end < command.length && !SPECIAL.has(command[end])) end++;
			if (bodyEnd !== -1 && end > bodyEnd) end = bodyEnd;
			word += command.slice(i, end);
			i = end - 1;
		}
	}
	endWord();
	return segments;
}

/**
 * For heredocs whose bodies start at `start`: where the last body ends (the start of its delimiter
 * line) and where the command resumes (after that line). An unterminated body runs to the end.
 */
function heredocSpan(
	command: string,
	start: number,
	heredocs: Array<{ delimiter: string; strip: boolean }>,
): { bodyEnd: number; resumeAt: number } {
	let from = start;
	let bodyEnd = command.length;
	let resumeAt = command.length;
	for (const { delimiter, strip } of heredocs) {
		bodyEnd = command.length;
		resumeAt = command.length;
		// Each candidate is checked once for being a whole line, so this is linear in the text.
		for (let at = command.indexOf(delimiter, from); at !== -1; at = command.indexOf(delimiter, at + 1)) {
			let lineStart = at;
			if (strip) while (lineStart > from && command[lineStart - 1] === "\t") lineStart--;
			const startsLine = lineStart === from || command[lineStart - 1] === "\n";
			const after = at + delimiter.length;
			if (startsLine && (after === command.length || command[after] === "\n")) {
				bodyEnd = lineStart;
				resumeAt = Math.min(after + 1, command.length);
				break;
			}
		}
		from = resumeAt;
	}
	return { bodyEnd, resumeAt };
}

/**
 * The `]` that closes the bracket expression at `open`, scanning only until a character that ends
 * the word. A `]` right after `[`, `[!` or `[^` is a member, and `[:class:]` is skipped whole.
 * Without one, `failedAt` is where the scan stopped: a later `[` before it cannot close either.
 */
function bracketEnd(command: string, open: number): { end: number } | { failedAt: number } {
	let j = open + 1;
	if (command[j] === "!" || command[j] === "^") j++;
	if (command[j] === "]") j++;
	while (j < command.length) {
		const c = command[j];
		if (c === "]") return { end: j };
		if (BREAKS.has(c)) return { failedAt: j };
		if (c === "[" && command[j + 1] === ":") {
			const close = command.indexOf(":]", j + 2);
			if (close === -1) return { failedAt: command.length };
			for (let k = j + 2; k < close; k++) if (BREAKS.has(command[k])) return { failedAt: k };
			j = close + 2;
			continue;
		}
		j++;
	}
	return { failedAt: command.length };
}
/**
 * For a tool about to read the file at absolute, normalized `path`: the refusal when it is a
 * credential location, also through a symlink under another name (`notes.json -> auth.json`). The
 * gate catches every spelling that keeps a credential name, so only a symlinked last component
 * needs this lstat.
 */
export function credentialFileReason(path: string): string | undefined {
	if (matchesCredential(fold(path), activeCredentialPaths())) return CREDENTIAL_BLOCK_REASON;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
		return matchesCredential(fold(canonicalizeTargetPath(path)), canonicalCredentialPaths())
			? CREDENTIAL_BLOCK_REASON
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * For lunR's recursive tools (grep, find, ast_search, code_rewrite, code_overview): a test for
 * paths under `root` that are credential locations, or undefined when `root` holds none. Callers
 * drop what it matches and add CREDENTIAL_SKIP_NOTE. `root` may be a file. The walkers do not
 * follow symlinks inside the tree, so paths map lexically from the canonical root.
 */
export function credentialWalkFilter(root: string): ((path: string) => boolean) | undefined {
	let rootPath: string;
	let realRoot: string;
	let real: CredentialPaths;
	try {
		rootPath = resolve(root);
		realRoot = fold(canonicalizeTargetPath(rootPath));
		real = canonicalCredentialPaths();
	} catch {
		return undefined;
	}
	if (matchesCredential(realRoot, real)) return () => true;
	const files: string[] = [];
	const trees: string[] = [];
	const lexicalRoot = fold(rootPath);
	for (const [paths, under] of [
		[real, realRoot],
		[activeCredentialPaths(), lexicalRoot],
	] as const) {
		for (const location of [paths.auth, paths.subscriptions]) {
			if (isWithin(location, under)) files.push(join(lexicalRoot, relative(under, location)));
		}
		if (isWithin(paths.mcp, under)) trees.push(join(lexicalRoot, relative(under, paths.mcp)));
	}
	if (files.length === 0 && trees.length === 0) return undefined;
	return (path) => {
		const target = fold(resolve(rootPath, path));
		return files.includes(target) || trees.some((tree) => target === tree || target.startsWith(tree + sep));
	};
}
