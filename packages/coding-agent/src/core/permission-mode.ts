import type { PermissionMode } from "./permissions.ts";

/**
 * lunR: permission-mode bridge for the ashxj-tui footer.
 *
 * Exposed on `globalThis` under `Symbol.for("@lunr/permission-mode")` so the
 * baked-in ashxj-tui extension can read the current permission mode without
 * importing core code — same pattern as the customize bridge.
 *
 * The bridge is provider-side: InteractiveMode (state owner) registers a
 * getter that returns the live mode at render time.
 */

export const PERMISSION_MODE_BRIDGE_SYMBOL = Symbol.for("@lunr/permission-mode");

export interface PermissionModeBridge {
	getMode(): PermissionMode | undefined;
}

let getModeFn: (() => PermissionMode | undefined) | undefined;

const bridge: PermissionModeBridge = {
	getMode(): PermissionMode | undefined {
		return getModeFn?.();
	},
};

export function registerPermissionModeBridge(getMode: () => PermissionMode | undefined): void {
	getModeFn = getMode;
	(globalThis as Record<symbol, unknown>)[PERMISSION_MODE_BRIDGE_SYMBOL] = bridge;
}

/** Read the bridge from `globalThis`, or undefined when not registered (extension-safe). */
export function getPermissionModeBridge(): PermissionModeBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[PERMISSION_MODE_BRIDGE_SYMBOL] as PermissionModeBridge | undefined;
}
