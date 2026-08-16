/**
 * lunr: parent-delegated children inherit a snapshot of the parent's permission
 * mode. Plan parents may only launch read-only agents. Any other parent mode
 * (or a missing/unknown snapshot on a real child) runs the child in auto so
 * writes can finish without a TUI approval channel.
 *
 * Ordinary `lunr -p`, cron, and gateway headless sessions are not children and
 * stay fail-closed.
 */

import { getPermissionMode, type PermissionMode, resetPermissions } from "./permissions.ts";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_PARENT_PERMISSION_MODE_ENV = "PI_SUBAGENT_PARENT_PERMISSION_MODE";

export const PLAN_MODE_WRITE_SPAWN_ERROR =
	"Cannot launch write-capable subagents in plan mode. Only read-only agents are allowed.";

/** Known writer basenames. Packaged names use `package.local`. */
const WRITE_CAPABLE_AGENT_BASENAMES = new Set(["worker", "delegate", "editor"]);

/**
 * Known research/review agents. Their roster may still list `write` for
 * scratch files; plan mode keeps those tools blocked instead of failing spawn.
 */
const READ_ONLY_AGENT_BASENAMES = new Set([
	"scout",
	"reviewer",
	"researcher",
	"research",
	"status",
	"oracle",
	"planner",
	"context-builder",
	"deep-researcher",
	"research-writer",
]);

/** Tools that make an unknown/custom agent write-capable at spawn time. */
const WRITE_CAPABLE_TOOLS = new Set([
	"edit",
	"write",
	"behavior_add",
	"behavior_remove",
	"memory_add",
	"memory_remove",
	"cron",
	"code_rewrite",
]);

const PLAN_STRIP_TOOLS = new Set(WRITE_CAPABLE_TOOLS);

export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

export function parseParentPermissionMode(value: string | undefined): PermissionMode | undefined {
	if (value === "manual" || value === "yolo" || value === "plan" || value === "auto") return value;
	return undefined;
}

/** Child mode for a real `PI_SUBAGENT_CHILD=1` process. Missing/unknown → auto. */
export function resolveChildPermissionMode(parentMode: string | undefined): PermissionMode {
	return parseParentPermissionMode(parentMode) === "plan" ? "plan" : "auto";
}

export function snapshotParentPermissionMode(sessionId?: string): PermissionMode {
	return getPermissionMode(sessionId);
}

/**
 * Apply the inherited child mode before any tool call. No-op for non-child
 * processes so `lunr -p` stays fail-closed.
 */
export function applyInheritedSubagentPermissions(env: NodeJS.ProcessEnv = process.env): PermissionMode | undefined {
	if (!isSubagentChildProcess(env)) return undefined;
	const childMode = resolveChildPermissionMode(env[SUBAGENT_PARENT_PERMISSION_MODE_ENV]);
	resetPermissions(childMode);
	return childMode;
}

export function agentBasename(name: string): string {
	const trimmed = name.trim();
	const dot = trimmed.lastIndexOf(".");
	return (dot >= 0 ? trimmed.slice(dot + 1) : trimmed).toLowerCase();
}

function isWriteCapableByName(name: string): boolean {
	const base = agentBasename(name);
	if (WRITE_CAPABLE_AGENT_BASENAMES.has(base)) return true;
	return base.endsWith("-editor") || base.endsWith("_editor");
}

/**
 * Writer agents fail spawn in plan mode. Known read-only names are allowed
 * even if their roster lists `write`. Unknown agents are writers when the
 * resolved tool list is unrestricted or contains a mutating tool. `bash` alone
 * does not count (inspection agents keep it).
 */
export function isWriteCapableSubagent(agentName: string, tools?: string[]): boolean {
	if (isWriteCapableByName(agentName)) return true;
	if (READ_ONLY_AGENT_BASENAMES.has(agentBasename(agentName))) return false;
	if (!tools || tools.length === 0) return true;
	return tools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool));
}

export function planModeWriteSpawnError(
	parentMode: string | undefined,
	agents: ReadonlyArray<{ name: string; tools?: string[] }>,
): string | undefined {
	if (parseParentPermissionMode(parentMode) !== "plan") return undefined;
	if (agents.some((agent) => isWriteCapableSubagent(agent.name, agent.tools))) {
		return PLAN_MODE_WRITE_SPAWN_ERROR;
	}
	return undefined;
}

/** Drop mutating tools from a plan child's `--tools` list. Leave `bash`. */
export function filterToolsForInheritedChild(
	tools: string[] | undefined,
	parentMode: string | undefined,
): string[] | undefined {
	if (!tools || parseParentPermissionMode(parentMode) !== "plan") return tools;
	return tools.filter((tool) => !PLAN_STRIP_TOOLS.has(tool));
}
