import type { SettingsManager } from "./settings-manager.ts";

/**
 * lunR TUI customize bridge.
 *
 * Exposed on `globalThis` under `Symbol.for("@lunr/customize")` so the baked-in
 * ashxj-tui extension can read footer element toggles without importing core
 * code, using the same pattern as
 * the model-tiers and memory-cap bridges.
 */

export const CUSTOMIZE_BRIDGE_SYMBOL = Symbol.for("@lunr/customize");

export interface CustomizeBridge {
	getOpenAIFastMode(): boolean;
	getFooterMcp(): boolean;
	getFooterLsp(): boolean;
	getFooterContext(): boolean;
	getFooterTokens(): boolean;
	getFooterCacheHitRate(): boolean;
	getFooterTps(): boolean;
	getFooterStatuses(): boolean;
	getFooterGit(): boolean;
	getFooterPlan(): boolean;
	getFooterPlanBar(): boolean;
	getHideThinkingBlock(): boolean;
	setHideThinkingBlock(hide: boolean): void;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: CustomizeBridge = {
	getOpenAIFastMode(): boolean {
		return activeSettingsManager?.getOpenAIFastMode() ?? false;
	},
	getFooterMcp(): boolean {
		return activeSettingsManager?.getFooterMcp() ?? true;
	},
	getFooterLsp(): boolean {
		return activeSettingsManager?.getFooterLsp() ?? false;
	},
	getFooterContext(): boolean {
		return activeSettingsManager?.getFooterContext() ?? true;
	},
	getFooterTokens(): boolean {
		return activeSettingsManager?.getFooterTokens() ?? true;
	},
	getFooterCacheHitRate(): boolean {
		return activeSettingsManager?.getFooterCacheHitRate() ?? true;
	},
	getFooterTps(): boolean {
		return activeSettingsManager?.getFooterTps() ?? true;
	},
	getFooterStatuses(): boolean {
		return activeSettingsManager?.getFooterStatuses() ?? true;
	},
	getFooterGit(): boolean {
		return activeSettingsManager?.getFooterGit() ?? true;
	},
	getFooterPlan(): boolean {
		return activeSettingsManager?.getFooterPlan() ?? true;
	},
	getFooterPlanBar(): boolean {
		return activeSettingsManager?.getFooterPlanBar() ?? true;
	},
	getHideThinkingBlock(): boolean {
		return activeSettingsManager?.getHideThinkingBlock() ?? false;
	},
	setHideThinkingBlock(hide: boolean): void {
		activeSettingsManager?.setHideThinkingBlock(hide);
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
