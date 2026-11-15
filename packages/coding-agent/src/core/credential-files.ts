import { lstatSync } from "node:fs";
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

/**
 * The refusal when a bash command names a credential location as a literal word or `--opt=` value
 * (`cat ~/.lunr/agent/auth.json`, `jq . <auth.json`), also relative to a literal `cd <dir>` before
 * it (`cd ~/.lunr/agent && cat auth.json`). Commands without one of the names return after one
 * regex test.
 */
export function credentialBashReason(command: string, cwd: string): string | undefined {
	if (!CREDENTIAL_NAME.test(command)) return undefined;
	let base = cwd;
	for (const words of literalSegments(command)) {
		if (words[0] === "cd" && words.length === 2) {
			base = resolveToCwd(words[1], base);
			continue;
		}
		for (const word of words) {
			const value = word.slice(word.lastIndexOf("=") + 1);
			if (credentialPathReason(word, base) || (value !== word && value && credentialPathReason(value, base))) {
				return CREDENTIAL_BLOCK_REASON;
			}
		}
	}
	return undefined;
}

/** Bash words with quotes and escapes removed, grouped by `;`, `|`, `&` and newline. */
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
			word += command[++i];
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
