import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isRollbackSessionForceEnabled } from "./rollback.ts";
import type { RollbackCapture, RollbackScope, SettingsManager } from "./settings-manager.ts";

export const SETTINGS_TOOLS_BRIDGE_SYMBOL = Symbol.for("@lunr/settings-tools");

export interface SettingsToolsBridge {
	getModelTiers(): Record<string, unknown>;
	setModelTiers(update: {
		enabled?: boolean;
		light?: string;
		standard?: string;
		heavy?: string;
		lightThinking?: ThinkingLevel | null;
		standardThinking?: ThinkingLevel | null;
		heavyThinking?: ThinkingLevel | null;
	}): void;
	getAutoManageSubscriptions(): boolean;
	setAutoManageSubscriptions(enabled: boolean): void;
	getRollback(): {
		enabled: boolean;
		turns: number;
		capture: RollbackCapture;
		scope: RollbackScope;
		forcedByAuto: boolean;
	};
	setRollback(update: { enabled?: boolean; turns?: number; capture?: RollbackCapture; scope?: RollbackScope }): void;
	getSessionRetentionDays(): number;
	setSessionRetentionDays(days: number): void;
}

let activeSettingsManager: SettingsManager | undefined;
let sessionIdProvider: (() => string | undefined) | undefined;

function manager(): SettingsManager {
	if (!activeSettingsManager) throw new Error("Settings are unavailable in this runtime. Reload lunR and try again.");
	return activeSettingsManager;
}

const bridge: SettingsToolsBridge = {
	getModelTiers: () => manager().getModelTiers() as Record<string, unknown>,
	setModelTiers(update) {
		const settings = manager();
		if (update.enabled !== undefined) settings.setModelTiersEnabled(update.enabled);
		for (const tier of ["light", "standard", "heavy"] as const) {
			const model = update[tier];
			if (model !== undefined) settings.setTierModel(tier, model);
			const key = `${tier}Thinking` as const;
			if (update[key] !== undefined) settings.setTierThinking(tier, update[key] ?? undefined);
		}
	},
	getAutoManageSubscriptions: () => manager().getAutoManageSubscriptions(),
	setAutoManageSubscriptions: (enabled) => manager().setAutoManageSubscriptions(enabled),
	getRollback: () => ({
		enabled: manager().getRollbackEnabled(),
		turns: manager().getRollbackTurns(),
		capture: manager().getRollbackCapture(),
		scope: manager().getRollbackScope(),
		forcedByAuto: isRollbackSessionForceEnabled(sessionIdProvider?.()),
	}),
	setRollback(update) {
		const settings = manager();
		if (update.enabled !== undefined) settings.setRollbackEnabled(update.enabled);
		if (update.turns !== undefined) settings.setRollbackTurns(update.turns);
		if (update.capture !== undefined) settings.setRollbackCapture(update.capture);
		if (update.scope !== undefined) settings.setRollbackScope(update.scope);
	},
	getSessionRetentionDays: () => manager().getSessionRetentionDays(),
	setSessionRetentionDays: (days) => manager().setSessionRetentionDays(days),
};

export function registerSettingsToolsBridge(
	settingsManager: SettingsManager,
	getSessionId?: () => string | undefined,
): void {
	activeSettingsManager = settingsManager;
	sessionIdProvider = getSessionId;
	(globalThis as Record<symbol, unknown>)[SETTINGS_TOOLS_BRIDGE_SYMBOL] = bridge;
}

export function getSettingsToolsBridge(): SettingsToolsBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[SETTINGS_TOOLS_BRIDGE_SYMBOL] as SettingsToolsBridge | undefined;
}
