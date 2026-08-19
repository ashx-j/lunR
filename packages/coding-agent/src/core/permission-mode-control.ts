import type { PermissionMode } from "./permissions.ts";

/**
 * lunR: permission-mode control bridge for the goal extension.
 *
 * Exposed on `globalThis` under `Symbol.for("@lunr/permission-mode-control")`
 * so the vendored goal extension can force session auto while a goal is
 * active without importing InteractiveMode.
 */

export const PERMISSION_MODE_CONTROL_SYMBOL = Symbol.for("@lunr/permission-mode-control");

export interface PermissionModeControlBridge {
	enterGoalAuto(): void;
	leaveGoalAuto(): void;
}

export type GoalPermissionEvent = "enter" | "leave";

/**
 * Pure save/restore helper for `/goal` forcing session auto.
 * `saved` is the mode in effect before the goal stretch (undefined = none).
 */
export function nextModeForGoal(
	current: PermissionMode,
	event: GoalPermissionEvent,
	saved: PermissionMode | undefined,
): { mode: PermissionMode; saved: PermissionMode | undefined } {
	if (event === "enter") {
		if (current === "auto") return { mode: "auto", saved };
		// Already inside a goal stretch: keep a hand-changed mode (yolo/plan/manual).
		if (saved !== undefined) return { mode: current, saved };
		return { mode: "auto", saved: current };
	}
	if (current === "auto" && saved !== undefined) {
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
