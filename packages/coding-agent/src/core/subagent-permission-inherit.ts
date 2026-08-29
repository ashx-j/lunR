/**
 * lunR: parent-delegated children inherit an explicit permission level, not a
 * named agent role. The parent process resolves the requested level against
 * its own mode, then snapshots that resolved child permission into the child
 * environment. Full maps to child runtime Auto; read-only maps to Plan.
 *
 * Ordinary `lunr -p`, cron, and gateway headless sessions are not children and
 * stay fail-closed.
 */

import { getPermissionMode, type PermissionMode, resetPermissions } from "./permissions.ts";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_CHILD_PERMISSION_ENV = "PI_SUBAGENT_CHILD_PERMISSION";
/** @deprecated Replaced by SUBAGENT_CHILD_PERMISSION_ENV. Kept so leftover env is ignored. */
export const SUBAGENT_PARENT_PERMISSION_MODE_ENV = "PI_SUBAGENT_PARENT_PERMISSION_MODE";

export type ChildPermission = "full" | "read-only";

export const PLAN_MODE_WRITE_SPAWN_ERROR =
	'Cannot launch a full-access child in plan mode. Relaunch with permissions: "read-only".';

export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

export function parseParentPermissionMode(value: string | undefined): PermissionMode | undefined {
	if (value === "manual" || value === "yolo" || value === "plan" || value === "auto") return value;
	return undefined;
}

export function parseChildPermission(value: string | undefined): ChildPermission | undefined {
	if (value === "full" || value === "read-only") return value;
	return undefined;
}

/** Omitted permissions resolve to full. Unknown values are rejected by the schema/executor. */
export function resolveRequestedChildPermission(requested?: string): ChildPermission {
	return requested === "read-only" ? "read-only" : "full";
}

export function resolveChildRuntimePermissionMode(childPermission: string | undefined): PermissionMode {
	return parseChildPermission(childPermission) === "read-only" ? "plan" : "auto";
}

export function snapshotParentPermissionMode(sessionId?: string): PermissionMode {
	return getPermissionMode(sessionId);
}

export interface ResolvedChildPermissions {
	ok: true;
	requested: ChildPermission;
	effective: ChildPermission;
}

export interface RejectedChildPermissions {
	ok: false;
	requested: ChildPermission;
	error: string;
}

/**
 * Resolve the child's permission level before spawn.
 *
 * Parent mode           Requested          Result
 * Manual/YOLO/Auto      omitted            Full
 * Manual/YOLO/Auto      full               Full
 * Manual/YOLO/Auto      read-only          Read-only
 * Plan                  read-only          Read-only
 * Plan                  full / omitted     Reject (omission resolves to full)
 */
export function resolveChildPermissions(
	parentMode: string | undefined,
	requested?: string,
): ResolvedChildPermissions | RejectedChildPermissions {
	const requestedPermission = resolveRequestedChildPermission(requested);
	if (parseParentPermissionMode(parentMode) === "plan" && requestedPermission === "full") {
		return { ok: false, requested: requestedPermission, error: PLAN_MODE_WRITE_SPAWN_ERROR };
	}
	return { ok: true, requested: requestedPermission, effective: requestedPermission };
}

/**
 * Apply the resolved child permission before any tool call. No-op for non-child
 * processes so `lunr -p` stays fail-closed.
 */
export function applyInheritedSubagentPermissions(env: NodeJS.ProcessEnv = process.env): PermissionMode | undefined {
	if (!isSubagentChildProcess(env)) return undefined;
	const childMode = resolveChildRuntimePermissionMode(env[SUBAGENT_CHILD_PERMISSION_ENV]);
	resetPermissions(childMode);
	return childMode;
}
