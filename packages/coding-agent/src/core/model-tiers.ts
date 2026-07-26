import type { ModelTierName, SettingsManager } from "./settings-manager.ts";

/**
 * 3-tier subagent model routing (light / standard / heavy).
 *
 * Plain module state holding the current SettingsManager. main.ts calls
 * initModelTiers() twice — once with the startup settings manager (before the
 * subagents feature builds its tool description) and once with the live runtime
 * settings manager so /settings changes take effect without a restart.
 */

export const TIER_NAMES: readonly ModelTierName[] = ["light", "standard", "heavy"];

function isModelTierName(tier: string): tier is ModelTierName {
	return tier === "light" || tier === "standard" || tier === "heavy";
}

let activeSettingsManager: SettingsManager | undefined;

/**
 * Point model-tier resolution at a settings manager.
 * Safe to call multiple times — later calls only swap the settings source, so an
 * early startup registration can be replaced by the live runtime settings manager.
 */
export function initModelTiers(settingsManager: SettingsManager): void {
	activeSettingsManager = settingsManager;
}

/** Resolve a tier to its configured "provider/model" string, or undefined if unset/unknown. */
export function getTierModel(tier: string): string | undefined {
	if (!activeSettingsManager || !isModelTierName(tier)) return undefined;
	return activeSettingsManager.getTierModel(tier);
}

/** Whether tier-based subagent routing is enabled in settings. */
export function isTierModeEnabled(): boolean {
	return activeSettingsManager?.getModelTiersEnabled() ?? false;
}
