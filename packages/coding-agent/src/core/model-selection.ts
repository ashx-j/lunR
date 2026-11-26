/**
 * Model and thinking level selection for AgentSession: `/model` and `--model` switches, model
 * cycling over scoped or available models, and setting, cycling and clamping the thinking level.
 * AgentSession keeps the public methods and supplies the agent, session and events through
 * ModelSelectionHost.
 */

import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, ModelCycleResult } from "./agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** What model selection needs from AgentSession. AgentSession builds one in `createModelSelectionHost`. */
export interface ModelSelectionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	emit(event: AgentSessionEvent): void;
	syncOpenAIServiceTier(): void;
	refreshSystemPromptForCurrentModel(): void;
	// AgentSession's public methods, so a model switch goes through them as before.
	setThinkingLevel(level: ThinkingLevel): void;
	getAvailableThinkingLevels(): ThinkingLevel[];
	supportsThinking(): boolean;
}

/** Standard thinking levels (no-model fallback). Live models use getSupportedThinkingLevels. */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function emitModelSelect(
	host: ModelSelectionHost,
	nextModel: Model<Api>,
	previousModel: Model<Api> | undefined,
	source: "set" | "cycle" | "restore",
): Promise<void> {
	if (modelsAreEqual(previousModel, nextModel)) return;
	await host.extensionRunner.emit({
		type: "model_select",
		model: nextModel,
		previousModel,
		source,
	});
}

/**
 * Set model directly.
 * Validates that auth is configured, saves to session and settings.
 * @throws Error if no auth is configured for the model
 */
export async function setModel(host: ModelSelectionHost, model: Model<Api>): Promise<void> {
	if (!(await host.modelRuntime.checkAuth(model.provider))) {
		throw new Error(`No API key for ${model.provider}/${model.id}`);
	}

	const previousModel = host.model;
	const thinkingLevel = thinkingLevelForModelSwitch(host);
	host.agent.state.model = model;
	host.syncOpenAIServiceTier();
	host.refreshSystemPromptForCurrentModel();
	host.sessionManager.appendModelChange(model.provider, model.id);
	host.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

	// Re-clamp thinking level for new model's capabilities
	host.setThinkingLevel(thinkingLevel);

	await emitModelSelect(host, model, previousModel, "set");
}

/**
 * Cycle to next/previous model.
 * Uses scoped models (from --models flag) if available, otherwise all available models.
 * @param direction - "forward" (default) or "backward"
 * @returns The new model info, or undefined if only one model available
 */
export async function cycleModel(
	host: ModelSelectionHost,
	direction: "forward" | "backward" = "forward",
): Promise<ModelCycleResult | undefined> {
	if (host.scopedModels.length > 0) {
		return cycleScopedModel(host, direction);
	}
	return cycleAvailableModel(host, direction);
}

async function cycleScopedModel(
	host: ModelSelectionHost,
	direction: "forward" | "backward",
): Promise<ModelCycleResult | undefined> {
	const checks = await Promise.all(
		host.scopedModels.map(async (scoped) => ({
			scoped,
			auth: await host.modelRuntime.checkAuth(scoped.model.provider),
		})),
	);
	const scopedModels = checks.filter(({ auth }) => auth !== undefined).map(({ scoped }) => scoped);
	if (scopedModels.length <= 1) return undefined;

	const currentModel = host.model;
	let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = scopedModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const next = scopedModels[nextIndex];
	const thinkingLevel = thinkingLevelForModelSwitch(host, next.thinkingLevel);

	// Apply model
	host.agent.state.model = next.model;
	host.syncOpenAIServiceTier();
	host.refreshSystemPromptForCurrentModel();
	host.sessionManager.appendModelChange(next.model.provider, next.model.id);
	host.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

	// Apply thinking level.
	// - Explicit scoped model thinking level overrides current session level
	// - Undefined scoped model thinking level inherits the current session preference
	// setThinkingLevel clamps to model capabilities.
	host.setThinkingLevel(thinkingLevel);

	await emitModelSelect(host, next.model, currentModel, "cycle");

	return { model: next.model, thinkingLevel: host.thinkingLevel, isScoped: true };
}

async function cycleAvailableModel(
	host: ModelSelectionHost,
	direction: "forward" | "backward",
): Promise<ModelCycleResult | undefined> {
	const availableModels = await host.modelRuntime.getAvailable();
	if (availableModels.length <= 1) return undefined;

	const currentModel = host.model;
	let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = availableModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const nextModel = availableModels[nextIndex];

	const thinkingLevel = thinkingLevelForModelSwitch(host);
	host.agent.state.model = nextModel;
	host.syncOpenAIServiceTier();
	host.refreshSystemPromptForCurrentModel();
	host.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
	host.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

	// Re-clamp thinking level for new model's capabilities
	host.setThinkingLevel(thinkingLevel);

	await emitModelSelect(host, nextModel, currentModel, "cycle");

	return { model: nextModel, thinkingLevel: host.thinkingLevel, isScoped: false };
}

/**
 * Set thinking level.
 * Clamps to model capabilities based on available thinking levels.
 * Saves to session and settings only if the level actually changes.
 */
export function setThinkingLevel(host: ModelSelectionHost, level: ThinkingLevel): void {
	const availableLevels = host.getAvailableThinkingLevels();
	const effectiveLevel = availableLevels.includes(level) ? level : clampLevelToModel(host, level);

	// Only persist if actually changing
	const previousLevel = host.agent.state.thinkingLevel;
	const isChanging = effectiveLevel !== previousLevel;

	host.agent.state.thinkingLevel = effectiveLevel;

	if (isChanging) {
		host.sessionManager.appendThinkingLevelChange(effectiveLevel);
		if (host.supportsThinking() || effectiveLevel !== "off") {
			host.settingsManager.setDefaultThinkingLevel(effectiveLevel);
		}
		host.emit({ type: "thinking_level_changed", level: effectiveLevel });
		void host.extensionRunner.emit({
			type: "thinking_level_select",
			level: effectiveLevel,
			previousLevel,
		});
	}
}

/**
 * Cycle to next thinking level.
 * @returns New level, or undefined if model doesn't support thinking
 */
export function cycleThinkingLevel(host: ModelSelectionHost): ThinkingLevel | undefined {
	if (!host.supportsThinking()) return undefined;

	const levels = host.getAvailableThinkingLevels();
	const currentIndex = levels.indexOf(host.thinkingLevel);
	const nextIndex = (currentIndex + 1) % levels.length;
	const nextLevel = levels[nextIndex];

	host.setThinkingLevel(nextLevel);
	return nextLevel;
}

/**
 * Get available thinking levels for current model.
 * Uses the registry row when /refresh has a newer copy than the session object.
 */
export function getAvailableThinkingLevels(host: ModelSelectionHost): ThinkingLevel[] {
	const model = resolvedCatalogModel(host);
	if (!model) return THINKING_LEVELS;
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function resolvedCatalogModel(host: ModelSelectionHost): Model<Api> | undefined {
	const current = host.model;
	if (!current) return undefined;
	const registry = host.modelRuntime.getModel(current.provider, current.id);
	if (!registry || registry === current) return current;
	const thinkingLevelMap =
		current.thinkingLevelMap || registry.thinkingLevelMap
			? { ...current.thinkingLevelMap, ...registry.thinkingLevelMap }
			: current.thinkingLevelMap;
	return {
		...current,
		...registry,
		compat: { ...current.compat, ...registry.compat },
		thinkingLevelMap,
	};
}

function thinkingLevelForModelSwitch(host: ModelSelectionHost, explicitLevel?: ThinkingLevel): ThinkingLevel {
	if (explicitLevel !== undefined) {
		return explicitLevel;
	}
	if (!host.supportsThinking()) {
		return host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}
	return host.thinkingLevel;
}

// Clamps against the registry copy, the same model getAvailableThinkingLevels reads, so a level the
// refreshed catalog dropped is not kept from a stale session model object.
function clampLevelToModel(host: ModelSelectionHost, level: ThinkingLevel): ThinkingLevel {
	const model = resolvedCatalogModel(host);
	return model ? (clampThinkingLevel(model, level) as ThinkingLevel) : "off";
}
