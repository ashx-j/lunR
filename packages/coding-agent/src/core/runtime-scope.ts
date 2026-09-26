import { AsyncLocalStorage } from "node:async_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface RuntimeScope {
	settingsManager: SettingsManager;
	modelRuntime?: ModelRuntime;
	thinking?: () => ThinkingLevel;
}
export const runtimeScope = new AsyncLocalStorage<RuntimeScope>();
