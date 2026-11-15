import { lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/**
 * Read-side guard for lunR's own saved logins in the active profile: `auth.json` (API keys and
 * OAuth tokens), `subscriptions.json` and the `mcp-oauth/` tree. `gateToolCall` runs it for
 * `read`, `grep` and `bash` in every mode, and the grep tool drops matches inside these files.
 * lunR's own code (login, `lunr doctor`) reads them directly and never passes through here.
 * It is a guard against an accidental or injected read, not a sandbox: bash variables, globs,
 * scripts that build the path at run time and a symlink under another name in a bash command are
 * not seen.
 */

// Tells the model how to get a value it needs, since the file itself stays closed.
export const CREDENTIAL_SHARE_HINT = "If you need a specific value, ask the user to share it.";
export const CREDENTIAL_READ_BLOCK_REASON = `This file holds lunR's saved logins (API keys and OAuth tokens), so the tools do not read it into the conversation. ${CREDENTIAL_SHARE_HINT}`;

/** Names a credential path keeps when only a parent directory is a symlink. tokens.json lives in mcp-oauth/sha256-<hash>/. */
const CREDENTIAL_NAMES = ["auth.json", "subscriptions.json", "mcp-oauth", "tokens.json"];
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function fold(path: string): string {
	return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

interface CredentialPaths {
	auth: string;
	subscriptions: string;
	mcp: string;
}

function credentialPathsIn(agentDir: string): CredentialPaths {
	const dir = fold(resolve(agentDir));
	return { auth: join(dir, "auth.json"), subscriptions: join(dir, "subscriptions.json"), mcp: join(dir, "mcp-oauth") };
}

// Keyed by the raw agent dir string, so a changed PI_CODING_AGENT_DIR rebuilds it. Plain string
// compares keep the common path off node:path's slower helpers.
let profilePaths: { agentDir: string; paths: CredentialPaths } | undefined;

function activeCredentialPaths(): CredentialPaths {
	const agentDir = getAgentDir();
	if (profilePaths?.agentDir !== agentDir) profilePaths = { agentDir, paths: credentialPathsIn(agentDir) };
	return profilePaths.paths;
}

/** `target` must be absolute and normalized, as resolveToCwd and realpath return it. */
function matchesCredential(target: string, paths: CredentialPaths): boolean {
	const path = fold(target);
	return path === paths.auth || path === paths.subscriptions || path === paths.mcp || path.startsWith(paths.mcp + sep);
}

/**
 * The refusal when `path` (relative to `cwd`, any spelling) names a credential file, else undefined.
 * Only a credential name or a symlink as the last component can alias one, so other paths cost a
 * string compare and one lstat; those two cases also resolve symlinks.
 */
export function credentialReadReason(path: string, cwd: string): string | undefined {
	const paths = activeCredentialPaths();
	const target = resolveToCwd(path, cwd);
	if (matchesCredential(target, paths)) return CREDENTIAL_READ_BLOCK_REASON;
	try {
		if (
			!CREDENTIAL_NAMES.includes(fold(target.slice(target.lastIndexOf(sep) + 1))) &&
			!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
		) {
			return undefined;
		}
		return matchesCredential(canonicalizeTargetPath(target), credentialPathsIn(canonicalizeTargetPath(getAgentDir())))
			? CREDENTIAL_READ_BLOCK_REASON
			: undefined;
	} catch {
		// A dangling link, a file used as a directory or an unreadable ancestor cannot be read either.
		return undefined;
	}
}

/**
 * The refusal when a bash command names a credential file as a literal word or `--opt=` value
 * (`cat ~/.lunr/agent/auth.json`, `jq . <auth.json`). Commands without a credential name return
 * after one substring scan.
 */
export function credentialBashReason(command: string, cwd: string): string | undefined {
	const folded = fold(command);
	if (!CREDENTIAL_NAMES.some((name) => folded.includes(name))) return undefined;
	for (const word of literalWords(command)) {
		const value = word.slice(word.lastIndexOf("=") + 1);
		for (const candidate of value === word ? [word] : [word, value]) {
			if (candidate && credentialReadReason(candidate, cwd)) return CREDENTIAL_READ_BLOCK_REASON;
		}
	}
	return undefined;
}

/** Bash words with quotes and escapes removed, split on blanks and unquoted operator characters. */
function literalWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			word += command[++i];
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (/[ \t\n;|&<>()`]/.test(ch)) {
			if (word) words.push(word);
			word = "";
		} else {
			word += ch;
		}
	}
	if (word) words.push(word);
	return words;
}
