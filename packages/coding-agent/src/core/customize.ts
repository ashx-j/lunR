import { runtimeScope } from "./runtime-scope.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SubagentSpinnerName } from "./subagent-spinner-setting.ts";

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
	getSubagentSpinner(): SubagentSpinnerName;
	getHideThinkingBlock(): boolean;
	setHideThinkingBlock(hide: boolean): void;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: CustomizeBridge = {
	getOpenAIFastMode(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getOpenAIFastMode() ?? false;
	},
	getFooterMcp(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterMcp() ?? true;
	},
	getFooterLsp(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterLsp() ?? false;
	},
	getFooterContext(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterContext() ?? true;
	},
	getFooterTokens(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterTokens() ?? true;
	},
	getFooterCacheHitRate(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterCacheHitRate() ?? true;
	},
	getFooterTps(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterTps() ?? true;
	},
	getFooterStatuses(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterStatuses() ?? true;
	},
	getFooterGit(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterGit() ?? true;
	},
	getFooterPlan(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterPlan() ?? true;
	},
	getFooterPlanBar(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getFooterPlanBar() ?? true;
	},
	getSubagentSpinner(): SubagentSpinnerName {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getSubagentSpinner() ?? "braille";
	},
	getHideThinkingBlock(): boolean {
		return (runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.getHideThinkingBlock() ?? false;
	},
	setHideThinkingBlock(hide: boolean): void {
		(runtimeScope.getStore()?.settingsManager ?? activeSettingsManager)?.setHideThinkingBlock(hide);
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
