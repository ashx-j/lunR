import type { SettingsManager } from "./settings-manager.ts";

/**
 * lunR TUI customize bridge.
 *
 * Exposed on `globalThis` under `Symbol.for("@lunr/customize")` so the baked-in
 * ashxj-tui extension can read the customize settings (gutter rail, prompt
 * symbol) without importing core code — same pattern as the model-tiers and
 * memory-cap bridges.
 */

export const CUSTOMIZE_BRIDGE_SYMBOL = Symbol.for("@lunr/customize");

export interface CustomizeBridge {
	getGutterRail(): boolean;
	getPromptSymbol(): boolean;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: CustomizeBridge = {
	getGutterRail(): boolean {
		return activeSettingsManager?.getGutterRail() ?? true;
	},
	getPromptSymbol(): boolean {
		return activeSettingsManager?.getPromptSymbol() ?? true;
	},
};

/**
 * Register (or re-point) the global customize bridge.
 * Safe to call multiple times — later calls only swap the settings source, so an
 * early startup registration (before extensions load) can be replaced by the live
 * runtime settings manager.
 */
export function registerCustomizeBridge(settingsManager: SettingsManager): void {
	activeSettingsManager = settingsManager;
	(globalThis as Record<symbol, unknown>)[CUSTOMIZE_BRIDGE_SYMBOL] = bridge;
}

/** Read the bridge from `globalThis`, or undefined when not registered (extension-safe). */
export function getCustomizeBridge(): CustomizeBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[CUSTOMIZE_BRIDGE_SYMBOL] as CustomizeBridge | undefined;
}
