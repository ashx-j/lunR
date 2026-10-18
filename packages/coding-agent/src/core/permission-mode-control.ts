import type { PermissionMode } from "./permissions.ts";

/**
 * lunR: permission-mode control bridge for the goal extension.
 *
 * Exposed on `globalThis` under `Symbol.for("@lunr/permission-mode-control")`
 * so the vendored goal extension can make the session work without questions
 * while a goal is active, without importing InteractiveMode.
 */

export const PERMISSION_MODE_CONTROL_SYMBOL = Symbol.for("@lunr/permission-mode-control");

export interface PermissionModeControlBridge {
	enterGoalAuto(): void;
	leaveGoalAuto(): void;
}

export type GoalPermissionEvent = "enter" | "leave";

/**
 * Pure save/restore helper for `/goal`. A goal works without asking questions (AgentSession
 * autonomy) in the user's current mode. Read-only can't make progress, so it switches to yolo
 * for the goal and comes back afterwards; `saved` holds that read-only mode while a goal runs.
 */
export function nextModeForGoal(
	current: PermissionMode,
	event: GoalPermissionEvent,
	saved: PermissionMode | undefined,
): { mode: PermissionMode; saved: PermissionMode | undefined } {
	if (event === "enter") {
		// Already inside a goal stretch: keep a hand-changed mode.
		if (saved !== undefined) return { mode: current, saved };
		return current === "read-only" ? { mode: "yolo", saved: current } : { mode: current, saved: undefined };
	}
	if (current === "yolo" && saved !== undefined) {
		return { mode: saved, saved: undefined };
	}
	return { mode: current, saved: undefined };
}

export function registerPermissionModeControlBridge(bridge: PermissionModeControlBridge): void {
	(globalThis as Record<symbol, unknown>)[PERMISSION_MODE_CONTROL_SYMBOL] = bridge;
}

export function getPermissionModeControlBridge(): PermissionModeControlBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[PERMISSION_MODE_CONTROL_SYMBOL] as
		| PermissionModeControlBridge
		| undefined;
}

export function enterGoalAuto(): void {
	getPermissionModeControlBridge()?.enterGoalAuto();
}

export function leaveGoalAuto(): void {
	getPermissionModeControlBridge()?.leaveGoalAuto();
}
