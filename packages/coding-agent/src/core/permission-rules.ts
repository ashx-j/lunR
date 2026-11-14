/**
 * lunR: allow and deny rules from `permissions.allow` / `permissions.deny` in settings.
 *
 * A rule is `tool` (every call of that tool) or `tool(pattern)`:
 * - `bash(pattern)` matches the command as a glob over the whole text, where `*` matches anything
 *   (`bash(npm test)` is exactly `npm test`, `bash(git push*)` is any git push).
 * - For tools with a `path` argument (edit, write, read, ...) the pattern is a path glob resolved
 *   against the working directory: `*` stays inside one folder, `**` crosses folders, `~/` is home.
 * - Other tools ignore patterns; a rule with a pattern never matches them.
 *
 * Deny rules match a bash command when any `;`, `&&`, `|`, `(` or backtick segment matches, so
 * chaining cannot hide a denied command. Allow rules never match a command with shell control or
 * expansion characters, so `bash(npm test*)` cannot approve `npm test; rm -rf ~`. Both are
 * heuristics over the text, like read-only mode's bash check, not a sandbox.
 *
 * Rules compile once per settings change (`compilePermissionRules` memoizes on the rule arrays).
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export interface PermissionRuleSettings {
	allow?: string[];
	deny?: string[];
}

type Matcher = (input: Record<string, unknown>) => boolean;

interface CompiledRule {
	source: string;
	tool: string;
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
/** Splits a command into the pieces a deny rule checks. */
const SHELL_SEGMENT_SPLIT = /\$\(|[;&|\n\r()`]/;
const ENV_ASSIGNMENT_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandRegex(pattern: string): RegExp {
	return new RegExp(`^${pattern.trim().split("*").map(escapeRegex).join(".*")}$`, "s");
}

function toSlashes(path: string): string {
	return path.replace(/\\/g, "/");
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
	return new RegExp(`^${body}$`, "s");
}

/** The glob with its literal folder prefix replaced by that folder's real path, so symlinks compare equal. */
function canonicalGlob(absoluteGlob: string): string {
	const firstWildcard = absoluteGlob.search(/[*?]/);
	if (firstWildcard === -1) return safeCanonical(absoluteGlob) ?? absoluteGlob;
	const cut = Math.max(toSlashes(absoluteGlob).lastIndexOf("/", firstWildcard), 0);
	const prefix = safeCanonical(absoluteGlob.slice(0, cut) || "/");
	return prefix ? `${prefix.replace(/[/\\]$/, "")}${absoluteGlob.slice(cut)}` : absoluteGlob;
}

function safeCanonical(path: string): string | undefined {
	try {
		return canonicalizeTargetPath(path);
	} catch {
		return undefined;
	}
}

function pathMatcher(pattern: string, cwd: string, kind: "allow" | "deny"): Matcher {
	const expanded = pattern === "~" || pattern.startsWith("~/") ? `${homedir()}${pattern.slice(1)}` : pattern;
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const raw = pathGlobRegex(absolute);
	const canonical = pathGlobRegex(canonicalGlob(absolute));
	return (input) => {
		if (typeof input.path !== "string" || !input.path) return false;
		const target = resolveToCwd(input.path, cwd);
		const real = safeCanonical(target);
		// Allow needs the real path to match, so a symlink inside an allowed folder can't reach outside it.
		if (kind === "allow") return real !== undefined && canonical.test(toSlashes(real));
		return raw.test(toSlashes(target)) || (real !== undefined && canonical.test(toSlashes(real)));
	};
}

function bashMatcher(pattern: string, kind: "allow" | "deny"): Matcher {
	const regex = commandRegex(pattern);
	return (input) => {
		if (typeof input.command !== "string") return false;
		const command = input.command.trim();
		if (kind === "allow") return !SHELL_CONTROL.test(command) && regex.test(command);
		if (regex.test(command)) return true;
		return command
			.split(SHELL_SEGMENT_SPLIT)
			.some((segment) => regex.test(segment.trim().replace(ENV_ASSIGNMENT_PREFIX, "")));
	};
}

/** Parses one rule, or returns undefined for text that isn't `tool` or `tool(pattern)`. */
export function parsePermissionRule(source: string): { tool: string; pattern?: string } | undefined {
	const match = RULE_SYNTAX.exec(source.trim());
	if (!match) return undefined;
	const pattern = match[2]?.trim();
	return { tool: match[1], ...(pattern ? { pattern } : {}) };
}

function compileRule(source: string, cwd: string, kind: "allow" | "deny"): CompiledRule | undefined {
	const parsed = parsePermissionRule(source);
	if (!parsed) return undefined;
	if (!parsed.pattern) return { source, tool: parsed.tool };
	const matches = parsed.tool === "bash" ? bashMatcher(parsed.pattern, kind) : pathMatcher(parsed.pattern, cwd, kind);
	return { source, tool: parsed.tool, matches };
}

function compileList(rules: readonly string[], cwd: string, kind: "allow" | "deny"): Map<string, CompiledRule[]> {
	const byTool = new Map<string, CompiledRule[]>();
	for (const source of rules) {
		if (typeof source !== "string") continue;
		const rule = compileRule(source, cwd, kind);
		if (!rule) continue;
		byTool.set(rule.tool, [...(byTool.get(rule.tool) ?? []), rule]);
	}
	return byTool;
}

function firstMatch(
	rules: Map<string, CompiledRule[]>,
	toolName: string,
	input: Record<string, unknown>,
): CompiledRule | undefined {
	return rules.get(toolName)?.find((rule) => !rule.matches || rule.matches(input));
}

const EMPTY: readonly string[] = [];
let memo:
	| {
			key: readonly unknown[];
			rules: CompiledPermissionRules;
	  }
	| undefined;

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
	const key = [global?.allow, global?.deny, project?.allow, project?.deny, projectTrusted, cwd];
	if (memo && memo.key.length === key.length && memo.key.every((part, i) => part === key[i])) return memo.rules;
	const allow = compileList(
		[...(global?.allow ?? EMPTY), ...(projectTrusted ? (project?.allow ?? EMPTY) : EMPTY)],
		cwd,
		"allow",
	);
	const deny = compileList([...(global?.deny ?? EMPTY), ...(project?.deny ?? EMPTY)], cwd, "deny");
	const rules: CompiledPermissionRules = {
		denied: (toolName, input) => firstMatch(deny, toolName, input)?.source,
		allowed: (toolName, input) => firstMatch(allow, toolName, input) !== undefined,
	};
	memo = { key, rules };
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
	if (typeof input.path === "string" && input.path) {
		const path = resolveToCwd(input.path, cwd);
		return /[*?()]/.test(path) ? undefined : `${toolName}(${path})`;
	}
	return undefined;
}
