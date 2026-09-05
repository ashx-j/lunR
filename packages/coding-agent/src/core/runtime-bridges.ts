import type { CreateAgentSessionRuntimeResult } from "./agent-session-runtime.ts";
import { registerCustomizeBridge } from "./customize.ts";
import { registerMemoryCapBridge } from "./memory-cap.ts";
import { getModelTiersBridge, registerModelTierBridge } from "./model-tiers.ts";
import { registerSettingsToolsBridge } from "./settings-tools-bridge.ts";
import { registerUsageServiceBridge } from "./usage-service.ts";

/** Re-point every settings-backed process-global bridge at the applied runtime. */
export function bindRuntimeBridges({
	session,
	services,
}: Pick<CreateAgentSessionRuntimeResult, "session" | "services">): void {
	const { settingsManager, modelRuntime } = services;
	registerModelTierBridge(settingsManager);
	getModelTiersBridge()?.setParentThinkingProvider(() => session.thinkingLevel);
	registerMemoryCapBridge(settingsManager);
	registerCustomizeBridge(settingsManager);
	registerUsageServiceBridge(modelRuntime, settingsManager);
	registerSettingsToolsBridge(settingsManager, () => session.sessionId);
}
