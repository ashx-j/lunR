import type { SettingsManager } from "./settings-manager.ts";

/**
 * simple-pi-memory character-cap bridge.
 *
 * The bridge is exposed on `globalThis` under `Symbol.for("@lunr/memory-cap")` so
 * the baked-in simple-pi-memory extension can read/write the cap from lunR
 * settings instead of its legacy `~/.pi/simple-memory/config.json` — without
 * importing core code (same pattern as the model-tiers bridge).
 */

export const MEMORY_CAP_BRIDGE_SYMBOL = Symbol.for("@lunr/memory-cap");

export const MEMORY_CHAR_CAP_DEFAULT = 5000;
export const MEMORY_CHAR_CAP_MIN = 1;
export const MEMORY_CHAR_CAP_MAX = 30000;

export interface MemoryCapBridge {
	/** Current character cap (clamped to 1..30000). */
	getCharCap(): number;
	/** Persist a new character cap into lunR settings. */
	setCharCap(cap: number): void;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: MemoryCapBridge = {
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
