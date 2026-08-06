import type { ModelTierName, SettingsManager } from "./settings-manager.ts";

/**
 * 3-tier subagent model routing (light / standard / heavy).
 *
 * The bridge is exposed on `globalThis` under `Symbol.for("@lunr/model-tiers")` so
 * builtin extensions (pi-subagents) can resolve `tier` params without importing core
 * code (avoids import cycles and keeps upstream diffs minimal).
 */

export const TIER_NAMES: readonly ModelTierName[] = ["light", "standard", "heavy"];

export const MODEL_TIERS_BRIDGE_SYMBOL = Symbol.for("@lunr/model-tiers");

export interface ModelTiersBridge {
	/** Resolve a tier to its configured "provider/model" string, or undefined if unset/unknown. */
	getTierModel(tier: string): string | undefined;
	/** Whether tier-based subagent routing is enabled in settings. */
	isTierModeEnabled(): boolean;
	/** Ask the pi-subagents extension to rebuild its tool description from current settings. */
	refreshToolDescription(): void;
	/** Register the callback used by {@link refreshToolDescription}. Called by the extension once at load. */
	registerToolDescriptionRefresher(refresher: () => void): void;
}

function isModelTierName(tier: string): tier is ModelTierName {
	return tier === "light" || tier === "standard" || tier === "heavy";
}

let activeSettingsManager: SettingsManager | undefined;
let toolDescriptionRefresher: (() => void) | undefined;

const bridge: ModelTiersBridge = {
	getTierModel(tier: string): string | undefined {
		if (!activeSettingsManager || !isModelTierName(tier)) return undefined;
		return activeSettingsManager.getTierModel(tier);
	},
	isTierModeEnabled(): boolean {
		return activeSettingsManager?.getModelTiersEnabled() ?? false;
	},
	refreshToolDescription(): void {
		toolDescriptionRefresher?.();
	},
	registerToolDescriptionRefresher(refresher: () => void): void {
		toolDescriptionRefresher = refresher;
	},
};

/**
 * Register (or re-point) the global model-tier bridge.
 * Safe to call multiple times — later calls only swap the settings source, so an
 * early startup registration (before extensions load) can be replaced by the live
 * runtime settings manager.
 */
export function registerModelTierBridge(settingsManager: SettingsManager): void {
	activeSettingsManager = settingsManager;
	(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = bridge;
}

/** Read the bridge from `globalThis`, or undefined when not registered (extension-safe). */
export function getModelTiersBridge(): ModelTiersBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] as ModelTiersBridge | undefined;
}

/** Resolve a tier to its configured "provider/model" string, or undefined if unset/unknown. */
export function getTierModel(tier: ModelTierName): string | undefined {
	return bridge.getTierModel(tier);
}

/** Whether tier-based subagent routing is enabled in settings. */
export function isTierModeEnabled(): boolean {
	return bridge.isTierModeEnabled();
}
