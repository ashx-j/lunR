import { lstatSync } from "node:fs";
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
const CREDENTIAL_NAME = CASE_INSENSITIVE
	? /auth\.json|subscriptions\.json|mcp-oauth/i
	: /auth\.json|subscriptions\.json|mcp-oauth/;
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

const CREDENTIAL_NAMES = ["auth.json", "subscriptions.json", "mcp-oauth"];
// The 3 names with quotes, backslashes or a line continuation allowed between characters: what is
// left of the name once bash removes them (`"auth".json`, `a''uth.json`, `auth\.json`).
const LOOSE_CREDENTIAL_NAME = new RegExp(
	CREDENTIAL_NAMES.map((name) => [...name].map((ch) => ch.replace(/[.-]/, "\\$&")).join(`['"\\\\\\n]*`)).join("|"),
	CASE_INSENSITIVE ? "i" : "",
);
const GLOB_CHAR = /[*?[]/;
// One scan that lets ordinary commands skip both tests below: no name, quote, backslash or glob.
const BASH_PREFILTER = CASE_INSENSITIVE
	? /[*?['"\\]|auth\.json|subscriptions\.json|mcp-oauth/i
	: /[*?['"\\]|auth\.json|subscriptions\.json|mcp-oauth/;

/**
 * The refusal when a bash command names a credential location, as bash reads it:
 * - a literal word or `--opt=` value (`cat ~/.lunr/agent/auth.json`, `jq . <"auth".json`), with
 *   `$HOME`, `${HOME}` and on Windows `$USERPROFILE` taken from lunR's own environment;
 * - relative to a literal `cd <dir>`, `cd -- <dir>` or `pushd <dir>` before it;
 * - a glob whose directory part is a credential directory and whose pattern matches a credential
 *   name (`cat ~/.lunr/agent/*.json`, `au[t]h.json` there).
 * Command substitution, other variables and assignments are not followed. A command with none of the
 * names, quotes, backslashes or glob characters returns after 1 regex test (about 20 ns more than
 * the name test alone).
 */
export function credentialBashReason(command: string, cwd: string): string | undefined {
	if (!BASH_PREFILTER.test(command)) return undefined;
	if (!LOOSE_CREDENTIAL_NAME.test(command) && !GLOB_CHAR.test(command)) return undefined;
	let base = cwd;
	for (const words of literalSegments(command).map((segment) => segment.map(fromMsysPath))) {
		const dir = changedDirectory(words);
		if (dir !== undefined) {
			base = resolveToCwd(dir, base);
			continue;
		}
		for (const word of words) {
			const value = fromMsysPath(word.slice(word.lastIndexOf("=") + 1));
			for (const candidate of value !== word && value ? [word, value] : [word]) {
				// After a cd, a word can name a file inside the mcp-oauth tree without any of the names.
				const named = base !== cwd || CREDENTIAL_NAME.test(candidate);
				if (named && credentialPathReason(candidate, base)) return CREDENTIAL_BLOCK_REASON;
				if (GLOB_CHAR.test(candidate) && globNamesCredential(candidate, base)) return CREDENTIAL_BLOCK_REASON;
			}
		}
	}
	return undefined;
}

/** The target of `cd <dir>`, `cd -- <dir>` or `pushd <dir>`, or undefined for any other command. */
function changedDirectory(words: string[]): string | undefined {
	if (words[0] !== "cd" && words[0] !== "pushd") return undefined;
	const args = words[1] === "--" ? words.slice(2) : words.slice(1);
	return args.length === 1 ? args[0] : undefined;
}

/**
 * Bash on Windows names drive `C:` as `/c` (Git Bash, MSYS2), `/cygdrive/c` (Cygwin) or `/mnt/c`
 * (WSL), so `/c/Users/me` is `C:/Users/me` there. `/c` alone is the drive's root, not `C:`, which
 * Node reads as the current directory on that drive.
 */
function fromMsysPath(word: string): string {
	return process.platform === "win32" ? word.replace(/^(?:\/cygdrive|\/mnt)?\/([a-z])(?=\/|$)/i, "$1:/") : word;
}

/** Bash on Windows also accepts `\` as a separator in a path it passes to a Windows program. */
const PATH_SEPARATORS = process.platform === "win32" ? /[\\/]/ : /\//;

/**
 * Whether glob `word` (relative to `base`) can match a credential file, or the `mcp-oauth` tree or
 * something in it. Only the directory part before the first glob character is resolved: lexically,
 * and through symlinks when a pattern component can match one of the names. A symlink into the
 * `mcp-oauth` tree under a glob matching none of them (`link/*`) is not followed.
 */
function globNamesCredential(word: string, base: string): boolean {
	const first = word.search(GLOB_CHAR);
	const head = word.slice(0, first);
	const cut = Math.max(head.lastIndexOf("/"), process.platform === "win32" ? head.lastIndexOf("\\") : -1);
	const pattern = word
		.slice(cut + 1)
		.split(PATH_SEPARATORS)
		.filter(Boolean)
		.map(globComponent);
	try {
		const dir = resolveToCwd(cut === -1 ? "." : word.slice(0, cut + 1), base);
		if (globMatches(pattern, fold(dir), activeCredentialPaths())) return true;
		// Resolving symlinks costs about 150 µs, so only a pattern that can match a name pays for it.
		const mayMatch = pattern.some((part) => CREDENTIAL_NAMES.some((name) => part.test(name)));
		return mayMatch && globMatches(pattern, fold(canonicalizeTargetPath(dir)), canonicalCredentialPaths());
	} catch {
		return false;
	}
}

function globMatches(pattern: RegExp[], dir: string, paths: CredentialPaths): boolean {
	if (isWithin(dir, paths.mcp)) return true;
	const covers = (location: string, tree: boolean) => {
		if (!isWithin(location, dir)) return false;
		const parts = relative(dir, location).split(sep);
		if (tree ? pattern.length < parts.length : pattern.length !== parts.length) return false;
		return parts.every((part, index) => pattern[index].test(part));
	};
	return covers(paths.auth, false) || covers(paths.subscriptions, false) || covers(paths.mcp, true);
}

/** One path component of a bash glob as a regex: `*`, `?` and `[...]` (with `!` or `^` negation). */
function globComponent(component: string): RegExp {
	let source = "";
	for (let i = 0; i < component.length; i++) {
		const ch = component[i];
		const close = ch === "[" ? component.indexOf("]", i + 2) : -1;
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else if (close !== -1) {
			const body = component
				.slice(i + 1, close)
				.replace(/^[!^]/, "^")
				.replace(/\\/g, "\\\\");
			source += `[${body}]`;
			i = close;
		} else source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, CASE_INSENSITIVE ? "i" : "");
}

// Inside double quotes bash keeps a backslash unless it escapes one of these, so a quoted Windows
// path such as "C:\Users\me\auth.json" keeps its separators.
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
// `$HOME` and `${HOME}` (and on Windows `$USERPROFILE`), which lunR passes to bash unchanged.
const HOME_VARIABLE =
	process.platform === "win32"
		? /\$(?:\{(HOME|USERPROFILE)\}|(HOME|USERPROFILE)(?![\w]))/y
		: /\$(?:\{(HOME)\}|(HOME)(?![\w]))/y;

/** The value bash gives a home variable: lunR's environment, or the home directory for an unset HOME. */
function homeVariable(name: string): string | undefined {
	return process.env[name] ?? (name === "HOME" ? homedir() : undefined);
}

/**
 * Bash words with quotes, escapes and line continuations removed and home variables expanded,
 * grouped by `;`, `|`, `&` and newline.
 */
function literalSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let word = "";
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (word) segments[segments.length - 1].push(word);
		word = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			if (command[i + 1] === "\n") i++;
			else if (quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(command[i + 1])) word += ch;
			else word += command[++i];
		} else if (ch === "$" && quote !== "'") {
			HOME_VARIABLE.lastIndex = i;
			const match = HOME_VARIABLE.exec(command);
			const value = match && homeVariable(match[1] ?? match[2]);
			if (match && value !== undefined) {
				word += value;
				i += match[0].length - 1;
			} else word += ch;
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			endWord();
			if (segments[segments.length - 1].length > 0) segments.push([]);
		} else if (/[ \t<>()`]/.test(ch)) {
			endWord();
		} else {
			word += ch;
		}
	}
	endWord();
	return segments;
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
