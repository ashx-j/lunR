import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
// The kernel refuses longer paths, so a longer `cd` base or word names nothing bash can open.
const PATH_MAX = 4096;
// Disk lookups (one `realpath` of a word's directory each) per command, so a command with thousands
// of distinct paths stays fast. Words after the limit are checked lexically only.
const MAX_DISK_LOOKUPS = 64;
// Missing directories a word's lookup walks up before it gives up (`new/dir/auth.json`).
const MAX_MISSING_LEVELS = 8;
const MAX_DELIMITER = 256;

let reportedBashFailure = false;

/**
 * The refusal when a bash command names a credential location. Matched, and nothing else:
 * - words and `--opt=` values that contain one of the names after removing quotes, `\` escapes and
 *   line continuations, including heredoc bodies that contain a name;
 * - with `$HOME`, `"$HOME"` and `${HOME}` (and `$USERPROFILE` on Windows) taken from lunR's
 *   environment, and Git Bash, Cygwin and WSL drive paths mapped on Windows;
 * - relative to the directory of a leading `cd`, `cd --`, `cd -L`/`-P` or `pushd` with a single
 *   argument (redirections such as `>/dev/null` ignored), undone by `popd`. After a `cd` into the
 *   `mcp-oauth` tree every plain word is checked.
 * See docs/agents/permissions-and-memory.md for what goes through. This is a guard for 3 file
 * names, not a sandbox.
 *
 * A command with no name, even split by quotes, returns after 1 regex scan. The rest is linear in
 * the command's length. A word that cannot be examined (a bad `file://` URL) is skipped and the
 * other words are still checked.
 */
export function credentialBashReason(command: string, cwd: string): string | undefined {
	try {
		return bashReason(command, cwd);
	} catch (error) {
		// Only a bug gets here, since every word is examined in its own try. Log the kind, not the text.
		if (!reportedBashFailure) {
			reportedBashFailure = true;
			console.error(
				`lunR: the saved-login check for bash failed (${error instanceof Error ? error.name : typeof error}).`,
			);
		}
		return undefined;
	}
}

/** Per-command caches (words, `cd` results, real directory paths) and the disk lookups used. */
interface BashCheck {
	cwd: string;
	paths: CredentialPaths;
	canonical?: CredentialPaths;
	words: Map<string, boolean>;
	wordsBase?: string;
	dirs: Map<string, string>;
	realDirs: Map<string, string | null>;
	lookups: number;
}

function bashReason(command: string, cwd: string): string | undefined {
	if (!LOOSE_CREDENTIAL_NAME.test(command)) return undefined;
	const check: BashCheck = {
		cwd,
		paths: activeCredentialPaths(),
		words: new Map(),
		dirs: new Map(),
		realDirs: new Map(),
		lookups: 0,
	};
	// Normalized once, so plain relative words can be joined to it.
	let base = resolve(cwd);
	let inTree = false;
	const pushed: string[] = [];
	for (const segment of bashSegments(command)) {
		const first = segment[0]?.text;
		if (first === "cd" || first === "pushd") {
			const target = directoryArgument(segment);
			if (target !== undefined) {
				if (first === "pushd") pushed.push(base);
				const next = changeDirectory(target, base, check);
				if (next !== base) inTree = baseInTree(next, target, check);
				base = next;
			}
			continue;
		}
		if (first === "popd") {
			base = pushed.pop() ?? base;
			inTree = under(fold(base), check.paths.mcp);
			continue;
		}
		for (const word of segment) {
			const named = CREDENTIAL_NAME.test(word.text);
			// After a `cd` into the mcp-oauth tree a plain word such as `tokens.json` can name a token file.
			if (!named && !inTree) continue;
			const text = fromMsysPath(word.text);
			const plain = inTree && !word.body && !/\s/.test(text);
			if ((named || plain) && wordNamesCredential(text, base, check)) return CREDENTIAL_BLOCK_REASON;
			const eq = text.lastIndexOf("=");
			if (eq === -1 || eq === text.length - 1) continue;
			const value = fromMsysPath(text.slice(eq + 1));
			if ((CREDENTIAL_NAME.test(value) || plain) && wordNamesCredential(value, base, check))
				return CREDENTIAL_BLOCK_REASON;
		}
	}
	return undefined;
}

/**
 * The directory after `cd target`, read as bash does: a plain path (`file://x` is relative), `~`
 * from HOME. Bash's `cd` fails and stays put for a directory that does not exist or is longer than
 * PATH_MAX, so the base moves only to an existing directory (checked within MAX_DISK_LOOKUPS;
 * after that a `cd` is assumed to succeed).
 */
function changeDirectory(target: string, base: string, check: BashCheck): string {
	const key = `${base}\0${target}`;
	const known = check.dirs.get(key);
	if (known !== undefined) return known;
	const next = followDirectory(target, base, check);
	check.dirs.set(key, next);
	return next;
}

function followDirectory(target: string, base: string, check: BashCheck): string {
	const mapped = fromMsysPath(target);
	const home = mapped === "~" || mapped.startsWith("~/") ? (homeVariable("HOME") ?? homedir()) : undefined;
	const path = home !== undefined ? home + mapped.slice(1) : mapped;
	// A relative target without `..` only lengthens the base, so it is too long before resolving it.
	if (!isAbsolute(path) && !path.includes("..") && base.length + 1 + path.length > PATH_MAX) return base;
	try {
		const next = resolve(base, path);
		if (next.length > PATH_MAX) return base;
		return directoryExists(next, check) === false ? base : next;
	} catch {
		return base;
	}
}

/** Whether `dir` exists, from a cached `realpath`; undefined once the command used its lookups. */
function directoryExists(dir: string, check: BashCheck): boolean | undefined {
	let real = check.realDirs.get(dir);
	if (real === undefined) {
		if (check.lookups >= MAX_DISK_LOOKUPS) return undefined;
		check.lookups++;
		try {
			real = realpathSync(dir);
		} catch {
			real = null;
		}
		check.realDirs.set(dir, real);
	}
	return real !== null;
}

/**
 * Whether the base after `cd target` is in the `mcp-oauth` tree: lexically, or through a symlink
 * when the target names `mcp-oauth` as a whole path segment (`cd profile/mcp-oauth`).
 */
function baseInTree(base: string, target: string, check: BashCheck): boolean {
	if (under(fold(base), check.paths.mcp)) return true;
	if (!target.split(/[\\/]/).some((segment) => fold(segment) === fold("mcp-oauth"))) return false;
	const real = realPath(base, check);
	check.canonical ??= canonicalCredentialPaths();
	return real !== undefined && under(fold(real), check.canonical.mcp);
}

/** Whether `word` (relative to `base`) is a credential location, lexically or through symlinks. */
function wordNamesCredential(word: string, base: string, check: BashCheck): boolean {
	// Words are cached for the current base; a `cd` to another base starts over.
	if (check.wordsBase !== base) {
		check.words.clear();
		check.wordsBase = base;
	}
	const seen = check.words.get(word);
	if (seen !== undefined) return seen;
	let target: string;
	try {
		// `resolveToCwd` also expands `~`, strips `@` and reads file URLs, at about 2.5 µs a word, and
		// `resolve` costs about 1.2 µs. A plain relative word only needs joining to the normalized base.
		if (isPlainRelative(word))
			target = (base.endsWith(sep) ? base : base + sep) + (sep === "/" ? word : word.replaceAll("/", sep));
		else target = /^[~@]|^file:/.test(word) ? resolveToCwd(word, base) : resolve(base, word);
	} catch {
		// A bad file URL names nothing readable; the other words are still checked.
		check.words.set(word, false);
		return false;
	}
	let hit = matchesCredential(fold(target), check.paths);
	if (!hit && target.length <= PATH_MAX) {
		const real = realPath(target, check);
		check.canonical ??= canonicalCredentialPaths();
		hit = real !== undefined && matchesCredential(fold(real), check.canonical);
	}
	check.words.set(word, hit);
	return hit;
}

/**
 * A relative word with no `.`, `..` or empty segment, no backslash and no drive: joining it to the
 * normalized base gives the same path as `resolve`. One pass over the word.
 */
function isPlainRelative(word: string): boolean {
	const first = word[0];
	if (!first || first === "~" || first === "@" || first === "/" || word.startsWith("file:")) return false;
	if (word.includes("\\") || word.includes("//") || word.endsWith("/") || /^[a-z]:/i.test(word)) return false;
	for (let start = 0; ; ) {
		const end = word.indexOf("/", start);
		const length = (end === -1 ? word.length : end) - start;
		if (word[start] === "." && (length === 1 || (length === 2 && word[start + 1] === "."))) return false;
		if (end === -1) return true;
		start = end + 1;
	}
}

/**
 * The real path of `target` through symlinks in its directories, from a cached `realpath` of the
 * nearest existing directory at most MAX_MISSING_LEVELS up. Undefined when that fails or the
 * command used its MAX_DISK_LOOKUPS.
 */
function realPath(target: string, check: BashCheck): string | undefined {
	const missing: string[] = [];
	let dir = target;
	for (let level = 0; level <= MAX_MISSING_LEVELS; level++) {
		// `target` is absolute and normalized, so its directories are prefixes up to a separator.
		const cut = dir.lastIndexOf(sep);
		if (cut <= 0 || cut === dir.length - 1) return undefined;
		missing.push(dir.slice(cut + 1));
		dir = dir.slice(0, dir.indexOf(sep) === cut ? cut + 1 : cut);
		if (directoryExists(dir, check) === undefined) return undefined;
		const real = check.realDirs.get(dir);
		if (real) return join(real, ...missing.reverse());
	}
	return undefined;
}

/** The single directory of a `cd` or `pushd` segment, without redirections and `-L`/`-P`/`-e`/`-@`. */
function directoryArgument(segment: BashWord[]): string | undefined {
	let index = 1;
	while (index < segment.length && (segment[index].redirect || /^-[LPe@]+$/.test(segment[index].text))) index++;
	if (segment[index]?.text === "--") index++;
	let target: string | undefined;
	for (; index < segment.length; index++) {
		if (segment[index].redirect) continue;
		if (target !== undefined) return undefined;
		target = segment[index].text;
	}
	return target === "-" ? undefined : target;
}

/**
 * Bash on Windows names drive `C:` as `/c` (Git Bash, MSYS2), `/cygdrive/c` (Cygwin) or `/mnt/c`
 * (WSL), so `/c/Users/me` is `C:/Users/me` there. `/c` alone is the drive's root, not `C:`, which
 * Node reads as the current directory on that drive.
 */
function fromMsysPath(word: string): string {
	return process.platform === "win32" ? word.replace(/^(?:\/cygdrive|\/mnt)?\/([a-z])(?=\/|$)/i, "$1:/") : word;
}

/** Whether absolute, normalized `target` is `root` or inside it. Node's path functions cost 1 to 4 µs. */
function under(target: string, root: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface BashWord {
	text: string;
	/** The target of a redirection (`>/dev/null`, `<<< x`). */
	redirect?: boolean;
	/** A line of a heredoc body. */
	body?: boolean;
}

// Inside double quotes bash keeps a backslash unless it escapes one of these, so a quoted Windows
// path such as "C:\Users\me\auth.json" keeps its separators.
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
const HOME_NAMES = process.platform === "win32" ? ["HOME", "USERPROFILE"] : ["HOME"];
// Characters the tokenizer acts on outside quotes; any other character is copied as it is.
const SPECIAL = new Set([" ", "\t", "\n", ";", "|", "&", "<", ">", "(", ")", "`", "'", '"', "\\", "$"]);

/** The value bash gives a home variable: lunR's environment, or the home directory for an unset HOME. */
function homeVariable(name: string): string | undefined {
	return process.env[name] ?? (name === "HOME" ? homedir() : undefined);
}

/**
 * Bash words grouped by `;`, `|`, `&` and newline, in one pass over the text: quotes, `\` escapes and
 * line continuations removed, home variables expanded (each read once), redirection targets marked,
 * and heredoc bodies kept as words of their own only when they contain a name (quotes there end at
 * each line).
 */
function bashSegments(command: string): BashWord[][] {
	const segments: BashWord[][] = [[]];
	const homes = new Map<string, string | undefined>();
	let word = "";
	let redirect = false;
	let heredocDelimiter: "plain" | "strip" | undefined;
	const heredocs: Array<{ delimiter: string; strip: boolean }> = [];
	let quote: "'" | '"' | undefined;
	let bodyEnd = -1;
	let resumeAt = -1;
	// Where the next name is, from the last search, so many heredocs do not each search to the end.
	let nameAt = -1;
	const newSegment = () => {
		if (segments[segments.length - 1].length > 0) segments.push([]);
	};
	const endWord = () => {
		if (!word) return;
		if (heredocDelimiter) heredocs.push({ delimiter: word, strip: heredocDelimiter === "strip" });
		else segments[segments.length - 1].push({ text: word, redirect, body: bodyEnd !== -1 });
		// A redirection or heredoc operator applies to the next word, also after a space (`<< 'EOF'`).
		redirect = false;
		heredocDelimiter = undefined;
		word = "";
	};
	const homeAt = (i: number): { length: number; value: string } | undefined => {
		for (const name of HOME_NAMES) {
			const braced = command.startsWith(`\${${name}}`, i);
			if (!braced && !(command.startsWith(`$${name}`, i) && !/\w/.test(command[i + name.length + 1] ?? "")))
				continue;
			if (!homes.has(name)) homes.set(name, homeVariable(name));
			const value = homes.get(name);
			if (value !== undefined) return { length: name.length + (braced ? 3 : 1), value };
		}
		return undefined;
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
			const home = homeAt(i);
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
				if (nameAt < i + 1) {
					LOOSE_CREDENTIAL_NAME_FROM.lastIndex = i + 1;
					nameAt = LOOSE_CREDENTIAL_NAME_FROM.exec(command)?.index ?? command.length;
				}
				// A body is data on stdin: only a name in it can matter, so a body without one is skipped.
				if (nameAt < span.bodyEnd) bodyEnd = span.bodyEnd;
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
		// Real delimiters are short; a long one would make each search costly, so it runs to the end.
		if (delimiter.length > MAX_DELIMITER) break;
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
