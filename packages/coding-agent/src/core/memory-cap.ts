import type { SettingsManager } from "./settings-manager.ts";

/** Memory settings shared with the baked-in simple-memory extension. */

export const MEMORY_CAP_BRIDGE_SYMBOL = Symbol.for("@lunr/memory-cap");

export const MEMORY_CHAR_CAP_DEFAULT = 5000;
export const MEMORY_CHAR_CAP_MIN = 1;
export const MEMORY_CHAR_CAP_MAX = 30000;
export const MEMORY_TOOL_NAMES = new Set(["memory_add", "memory_remove", "memory_load"]);

export interface MemoryCapBridge {
	isEnabled(): boolean;
	/** Current character cap (clamped to 1..30000). */
	getCharCap(): number;
	/** Persist a new character cap into lunR settings. */
	setCharCap(cap: number): void;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: MemoryCapBridge = {
	isEnabled(): boolean {
		return activeSettingsManager?.getMemoryEnabled() ?? true;
	},
	getCharCap(): number {
		return activeSettingsManager?.getMemoryCharCap() ?? MEMORY_CHAR_CAP_DEFAULT;
	},
	setCharCap(cap: number): void {
		activeSettingsManager?.setMemoryCharCap(cap);
	},
};

/**
 * Register (or re-point) the global memory-cap bridge.
 * Safe to call multiple times — later calls only swap the settings source, so an
 * early startup registration (before extensions load) can be replaced by the live
 * runtime settings manager.
 */
export function registerMemoryCapBridge(settingsManager: SettingsManager): void {
	activeSettingsManager = settingsManager;
	(globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL] = bridge;
}

export function getMemoryCapBridge(): MemoryCapBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL] as MemoryCapBridge | undefined;
}
