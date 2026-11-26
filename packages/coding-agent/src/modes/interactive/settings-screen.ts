/**
 * The /settings screen for interactive mode. `buildSettingsValues` reads what every row shows when
 * the screen opens; the section callback builders below handle a changed row, each covering the
 * rows of one part of the screen. InteractiveMode supplies the session, UI and the display state
 * the rows change through SettingsScreenHost.
 */

import { spawn } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Component, Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { getGlobalInstructionsPath, getModelInstructionsPath } from "../../core/model-instructions.ts";
import { getModelTiersBridge } from "../../core/model-tiers.ts";
import { isRollbackSessionForceEnabled } from "../../core/rollback.ts";
import { getSearchCuratorSetting, setSearchCuratorSetting } from "../../core/search-curator.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { notifyTodosEnabledChanged } from "../../core/todo-settings.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "./components/settings-selector.ts";
import type { StatusIndicator } from "./components/status-indicator.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { countSubscriptions, listSubscriptionRows } from "./model-commands.ts";
import { getAvailableThemes } from "./theme/theme.ts";
import type { InteractiveThemeController } from "./theme/theme-controller.ts";

/** What /settings needs from InteractiveMode. InteractiveMode builds one in `createSettingsScreenHost`. */
export interface SettingsScreenHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly statusContainer: Container;
	readonly footer: FooterComponent;
	readonly themeController: InteractiveThemeController;
	/** The built-in editor; padding and autocomplete rows set it and any extension editor. */
	readonly defaultEditor: CustomEditor;
	readonly editor: EditorComponent;
	/** The assistant message still streaming, which an output pad change pads in place. */
	readonly streamingComponent: AssistantMessageComponent | undefined;
	/** A clear-on-shrink change keeps the status row while an indicator shows. */
	readonly activeStatusIndicator: StatusIndicator | undefined;
	// Display state InteractiveMode's chat rendering reads; the rows change it.
	hideThinkingBlock: boolean;
	thinkingCollapse: boolean;
	outputPad: number;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	rebuildChatFromMessages(): void;
	setupAutocompleteProvider(): void;
	updateEditorBorderColor(): void;
	applySmoothStreamingSettingChange(enabled: boolean): void;
	resolveModelReference(reference: string | undefined): Model<Api> | undefined;
	showAutoReviewModelPicker(): void;
}

/** Opens /settings. Reads the current values once, then each row's change goes to its section's callbacks. */
export async function showSettingsSelector(host: SettingsScreenHost): Promise<void> {
	// lunr: prefetch the pool size for the API keys row label (render paths stay sync).
	const subscriptionCount = await countSubscriptions(host.session);
	host.showSelector((done) => {
		const selector = new SettingsSelectorComponent(buildSettingsValues(host, subscriptionCount), {
			...chatCallbacks(host),
			...interfaceCallbacks(host),
			...agentCallbacks(host),
			...footerCallbacks(host),
			...gatewayCallbacks(host),
			...permissionCallbacks(host, done),
			...subscriptionCallbacks(host, done),
		});
		return { component: selector, focus: selector.getSettingsList() };
	});
}

/** The value every row shows when /settings opens. */
function buildSettingsValues(host: SettingsScreenHost, subscriptionCount: number): SettingsConfig {
	return {
		autoCompact: host.session.autoCompactionEnabled,
		compactionCeilingTokens: host.settingsManager.getCompactionCeilingTokens(),
		compactionCeilingFloorTokens: host.session.getCompactionCeilingFloor().floor,
		compactionCeilingKeptTokens: host.session.getCompactionCeilingFloor().keptTokens,
		showImages: host.settingsManager.getShowImages(),
		imageWidthCells: host.settingsManager.getImageWidthCells(),
		autoResizeImages: host.settingsManager.getImageAutoResize(),
		blockImages: host.settingsManager.getBlockImages(),
		enableSkillCommands: host.settingsManager.getEnableSkillCommands(),
		skillTagCharacter: host.settingsManager.getSkillTagCharacter(),
		steeringMode: host.session.steeringMode,
		followUpMode: host.session.followUpMode,
		transport: host.settingsManager.getTransport(),
		httpIdleTimeoutMs: host.settingsManager.getHttpIdleTimeoutMs(),
		thinkingLevel: host.session.thinkingLevel,
		availableThinkingLevels: host.session.getAvailableThinkingLevels(),
		currentTheme: host.settingsManager.getThemeSetting() || "moon",
		terminalTheme: host.themeController.getTerminalTheme(),
		availableThemes: getAvailableThemes(),
		hideThinkingBlock: host.hideThinkingBlock,
		thinkingCollapse: host.thinkingCollapse,
		reasoningDisplay: host.settingsManager.getReasoningDisplay(),
		cacheRetention: host.settingsManager.getCacheRetention() ?? "short",
		doubleEscapeAction: host.settingsManager.getDoubleEscapeAction(),
		treeFilterMode: host.settingsManager.getTreeFilterMode(),
		showHardwareCursor: host.settingsManager.getShowHardwareCursor(),
		showCacheMissNotices: host.settingsManager.getShowCacheMissNotices(),
		defaultProjectTrust: host.settingsManager.getDefaultProjectTrust(),
		editorPaddingX: host.settingsManager.getEditorPaddingX(),
		outputPad: host.settingsManager.getOutputPad(),
		autocompleteMaxVisible: host.settingsManager.getAutocompleteMaxVisible(),
		quietStartup: host.settingsManager.getQuietStartup(),
		smoothStreaming: host.settingsManager.getSmoothStreaming(),
		subagentSpinner: host.settingsManager.getSubagentSpinner(),
		sessionRetentionDays: host.settingsManager.getSessionRetentionDays(),
		clearOnShrink: host.settingsManager.getClearOnShrink(),
		showTerminalProgress: host.settingsManager.getShowTerminalProgress(),
		attentionNotification: host.settingsManager.getAttentionNotification(),
		modelTiers: host.settingsManager.getModelTiers(),
		modelInstructions: host.settingsManager.getModelInstructions(),
		globalInstructionsPath: getGlobalInstructionsPath(getAgentDir()),
		modelInstructionsPath: getModelInstructionsPath(getAgentDir(), host.session.model?.id ?? "no-model-selected"),
		confirmLargeSubagentLaunches: host.settingsManager.getConfirmLargeSubagentLaunches(),
		clientScopedModelsOnly: host.settingsManager.getClientScopedModelsOnly(),
		computerUse: host.settingsManager.getComputerUse(),
		computerForeground: host.settingsManager.getComputerForeground(),
		subagentCommunicationEnabled: host.settingsManager.getSubagentCommunicationEnabled(),
		automaticSubagentDelegation: host.settingsManager.getAutomaticSubagentDelegation(),
		browserEnabled: host.settingsManager.getBrowserEnabled(),
		prWatchDurationMs: host.settingsManager.getPrWatchDurationMs(),
		memoryEnabled: host.settingsManager.getMemoryEnabled(),
		memoryCharCap: host.settingsManager.getMemoryCharCap(),
		todosEnabled: host.settingsManager.getTodosEnabled(),
		deferredToolsEnabled: host.settingsManager.getDeferredToolsEnabled(),
		searchCurator: getSearchCuratorSetting(),
		// lunr: TUI customize settings
		footerMcp: host.settingsManager.getFooterMcp(),
		footerLsp: host.settingsManager.getFooterLsp(),
		footerContext: host.settingsManager.getFooterContext(),
		footerTokens: host.settingsManager.getFooterTokens(),
		footerCacheHitRate: host.settingsManager.getFooterCacheHitRate(),
		footerTps: host.settingsManager.getFooterTps(),
		footerStatuses: host.settingsManager.getFooterStatuses(),
		footerGit: host.settingsManager.getFooterGit(),
		footerPlan: host.settingsManager.getFooterPlan(),
		footerPlanBar: host.settingsManager.getFooterPlanBar(),
		planUsageWindow: host.settingsManager.getPlanUsageWindow(),
		defaultPermissionMode: host.settingsManager.getDefaultPermissionMode(),
		autoReviewModel: host.settingsManager.getAutoReviewModel(),
		rollbackEnabled: host.settingsManager.getRollbackEnabled(),
		rollbackTurns: host.settingsManager.getRollbackTurns(),
		rollbackCapture: host.settingsManager.getRollbackCapture(),
		rollbackScope: host.settingsManager.getRollbackScope(),
		// lunr: multi-subscription pools
		autoManageSubscriptions: host.settingsManager.getAutoManageSubscriptions(),
		subscriptionCount,
	};
}

/** Compaction, images, skill commands, queue modes, transport, thinking, theme and chat display rows. */
function chatCallbacks(host: SettingsScreenHost) {
	return {
		onAutoCompactChange: (enabled) => {
			host.session.setAutoCompactionEnabled(enabled);
			host.footer.setAutoCompactEnabled(enabled);
		},
		onCompactionCeilingChange: (ceilingTokens) => {
			host.settingsManager.setCompactionCeilingTokens(ceilingTokens);
		},
		onShowImagesChange: (enabled) => {
			host.settingsManager.setShowImages(enabled);
			for (const child of host.chatContainer.children) {
				if (child instanceof ToolExecutionComponent) {
					child.setShowImages(enabled);
				}
			}
		},
		onImageWidthCellsChange: (width) => {
			host.settingsManager.setImageWidthCells(width);
			for (const child of host.chatContainer.children) {
				if (child instanceof ToolExecutionComponent) {
					child.setImageWidthCells(width);
				}
			}
		},
		onAutoResizeImagesChange: (enabled) => {
			host.settingsManager.setImageAutoResize(enabled);
		},
		onBlockImagesChange: (blocked) => {
			host.settingsManager.setBlockImages(blocked);
		},
		onEnableSkillCommandsChange: (enabled) => {
			host.settingsManager.setEnableSkillCommands(enabled);
			host.setupAutocompleteProvider();
		},
		onSkillTagCharacterChange: (character) => {
			host.settingsManager.setSkillTagCharacter(character);
			host.setupAutocompleteProvider();
		},
		onSteeringModeChange: (mode) => {
			host.session.setSteeringMode(mode);
		},
		onFollowUpModeChange: (mode) => {
			host.session.setFollowUpMode(mode);
		},
		onTransportChange: (transport) => {
			host.settingsManager.setTransport(transport);
			host.session.agent.transport = transport;
		},
		onHttpIdleTimeoutMsChange: (timeoutMs) => {
			host.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
			configureHttpDispatcher(timeoutMs);
			host.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
		},
		onThinkingLevelChange: (level) => {
			host.session.setThinkingLevel(level);
			host.footer.invalidate();
			host.updateEditorBorderColor();
		},
		onThemeChange: (themeSetting) => {
			host.settingsManager.setTheme(themeSetting);
			void host.themeController.applyFromSettings();
		},
		onThemePreview: (themeName) => host.themeController.preview(themeName),
		onHideThinkingBlockChange: (hidden) => {
			host.hideThinkingBlock = hidden;
			host.settingsManager.setHideThinkingBlock(hidden);
			for (const child of host.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) {
					child.setHideThinkingBlock(hidden);
				}
			}
			host.rebuildChatFromMessages();
		},
		onThinkingCollapseChange: (collapse) => {
			host.thinkingCollapse = collapse;
			host.settingsManager.setThinkingCollapse(collapse);
			for (const child of host.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) {
					child.setThinkingCollapse(collapse);
				}
			}
			host.rebuildChatFromMessages();
		},
		onReasoningDisplayChange: (display) => {
			host.settingsManager.setReasoningDisplay(display);
			for (const child of host.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) {
					child.setReasoningDisplay(host.settingsManager.getReasoningDisplay());
				}
			}
			host.ui.requestRender();
		},
		onShowCacheMissNoticesChange: (shown) => {
			host.settingsManager.setShowCacheMissNotices(shown);
			host.rebuildChatFromMessages();
		},
		onCacheRetentionChange: (retention) => {
			host.settingsManager.setCacheRetention(retention);
		},
	} satisfies Partial<SettingsCallbacks>;
}

/** Startup, streaming, spinner, sessions, editor, output and terminal rows. */
function interfaceCallbacks(host: SettingsScreenHost) {
	return {
		onQuietStartupChange: (enabled) => {
			host.settingsManager.setQuietStartup(enabled);
		},
		onSmoothStreamingChange: (enabled) => {
			host.applySmoothStreamingSettingChange(enabled);
		},
		onSubagentSpinnerChange: (spinner) => {
			host.settingsManager.setSubagentSpinner(spinner);
			host.ui.requestRender();
		},
		onSessionRetentionDaysChange: (days) => {
			host.settingsManager.setSessionRetentionDays(days);
		},
		onDefaultProjectTrustChange: (defaultProjectTrust) => {
			host.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
		},
		onDoubleEscapeActionChange: (action) => {
			host.settingsManager.setDoubleEscapeAction(action);
		},
		onTreeFilterModeChange: (mode) => {
			host.settingsManager.setTreeFilterMode(mode);
		},
		onShowHardwareCursorChange: (enabled) => {
			host.settingsManager.setShowHardwareCursor(enabled);
			host.ui.setShowHardwareCursor(enabled);
		},
		onEditorPaddingXChange: (padding) => {
			host.settingsManager.setEditorPaddingX(padding);
			host.defaultEditor.setPaddingX(padding);
			if (host.editor !== host.defaultEditor && host.editor.setPaddingX !== undefined) {
				host.editor.setPaddingX(padding);
			}
		},
		onOutputPadChange: (padding) => {
			host.settingsManager.setOutputPad(padding);
			host.outputPad = padding;
			if (host.streamingComponent || host.session.isStreaming) {
				for (const child of host.chatContainer.children) {
					if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent) {
						child.setOutputPad(padding);
					}
				}
				if (host.streamingComponent) {
					host.streamingComponent.setOutputPad(padding);
				}
				host.ui.requestRender();
				return;
			}
			host.rebuildChatFromMessages();
		},
		onAutocompleteMaxVisibleChange: (maxVisible) => {
			host.settingsManager.setAutocompleteMaxVisible(maxVisible);
			host.defaultEditor.setAutocompleteMaxVisible(maxVisible);
			if (host.editor !== host.defaultEditor && host.editor.setAutocompleteMaxVisible !== undefined) {
				host.editor.setAutocompleteMaxVisible(maxVisible);
			}
		},
		onClearOnShrinkChange: (enabled) => {
			host.settingsManager.setClearOnShrink(enabled);
			host.ui.setClearOnShrink(enabled);
			if (!enabled && !host.activeStatusIndicator) {
				host.statusContainer.clear();
			}
		},
		onShowTerminalProgressChange: (enabled) => {
			host.settingsManager.setShowTerminalProgress(enabled);
			if (!enabled) host.ui.terminal.setProgress(false);
		},
		onAttentionNotificationChange: (mode) => {
			host.settingsManager.setAttentionNotification(mode);
			host.ui.setFocusReporting(mode !== "off");
		},
	} satisfies Partial<SettingsCallbacks>;
}

/** Model tiers, model instructions, subagents, memory, computer use, browser, PR watch, todos, deferred tools and search rows. */
function agentCallbacks(host: SettingsScreenHost) {
	return {
		onModelTiersEnabledChange: (enabled) => {
			host.settingsManager.setModelTiersEnabled(enabled);
			getModelTiersBridge()?.refreshToolDescription();
		},
		onModelTierModelChange: (tier, model) => {
			host.settingsManager.setTierModel(tier, model);
		},
		onModelTierThinkingChange: (tier, level) => {
			host.settingsManager.setTierThinking(tier, level);
		},
		onModelInstructionsEnabledChange: (enabled) => {
			host.settingsManager.setModelInstructionsEnabled(enabled);
			host.session.refreshToolRegistry();
		},
		onModelInstructionsModeChange: (mode) => {
			host.settingsManager.setModelInstructionsMode(mode);
			host.session.refreshToolRegistry();
		},
		onConfirmLargeSubagentLaunchesChange: (enabled) => {
			host.settingsManager.setConfirmLargeSubagentLaunches(enabled);
		},
		onClientScopedModelsOnlyChange: (enabled) => {
			host.settingsManager.setClientScopedModelsOnly(enabled);
		},
		onSubagentCommunicationChange: (enabled) => {
			host.settingsManager.setSubagentCommunicationEnabled(enabled);
		},
		onAutomaticSubagentDelegationChange: (enabled) => {
			host.settingsManager.setAutomaticSubagentDelegation(enabled);
			host.session.refreshToolRegistry();
		},
		getTierThinkingLevels: (tier) => {
			const model = host.resolveModelReference(host.settingsManager.getTierModel(tier));
			if (model) return getSupportedThinkingLevels(model);
			return host.session.getAvailableThinkingLevels();
		},
		onMemoryCharCapChange: (cap) => {
			host.settingsManager.setMemoryCharCap(cap);
		},
		onComputerUseChange: (enabled) => {
			host.settingsManager.setComputerUse(enabled);
		},
		onComputerForegroundChange: (enabled) => {
			host.settingsManager.setComputerForeground(enabled);
		},
		onBrowserEnabledChange: (enabled) => {
			host.settingsManager.setBrowserEnabled(enabled);
			host.session.refreshToolRegistry();
		},
		onPrWatchDurationChange: (durationMs) => {
			host.settingsManager.setPrWatchDurationMs(durationMs);
		},
		onMemoryEnabledChange: (enabled) => {
			host.settingsManager.setMemoryEnabled(enabled);
			host.session.refreshToolRegistry();
			host.showStatus(`Agent memory: ${enabled ? "on" : "off"}`);
		},
		// lunr: saved only; a running session keeps its tool list.
		onDeferredToolsEnabledChange: (enabled) => {
			host.settingsManager.setDeferredToolsEnabled(enabled);
		},
		onTodosEnabledChange: (enabled) => {
			host.settingsManager.setTodosEnabled(enabled);
			notifyTodosEnabledChanged(enabled);
			host.session.refreshToolRegistry();
		},
		onSearchCuratorChange: (setting) => {
			if (!setSearchCuratorSetting(setting)) {
				host.showError("pi-web-access is not loaded; curator setting unavailable.");
			}
		},
	} satisfies Partial<SettingsCallbacks>;
}

/** The Customize rows that toggle footer segments, and the plan usage window. */
function footerCallbacks(host: SettingsScreenHost) {
	return {
		// lunr: TUI customize callbacks
		onFooterMcpChange: (enabled) => {
			host.settingsManager.setFooterMcp(enabled);
		},
		onFooterLspChange: (enabled) => {
			host.settingsManager.setFooterLsp(enabled);
		},
		onFooterContextChange: (enabled) => {
			host.settingsManager.setFooterContext(enabled);
		},
		onFooterTokensChange: (enabled) => {
			host.settingsManager.setFooterTokens(enabled);
		},
		onFooterCacheHitRateChange: (enabled) => {
			host.settingsManager.setFooterCacheHitRate(enabled);
		},
		onFooterTpsChange: (enabled) => {
			host.settingsManager.setFooterTps(enabled);
		},
		onFooterStatusesChange: (enabled) => {
			host.settingsManager.setFooterStatuses(enabled);
		},
		onFooterGitChange: (enabled) => {
			host.settingsManager.setFooterGit(enabled);
		},
		onFooterPlanChange: (enabled) => {
			host.settingsManager.setFooterPlan(enabled);
		},
		onFooterPlanBarChange: (enabled) => {
			host.settingsManager.setFooterPlanBar(enabled);
		},
		onPlanUsageWindowChange: (window) => {
			host.settingsManager.setPlanUsageWindow(window);
		},
	} satisfies Partial<SettingsCallbacks>;
}

/** The gateway actions row: status inline, other actions run `lunr gateway` with the TUI stopped. */
function gatewayCallbacks(host: SettingsScreenHost) {
	return {
		onGatewayAction: (action) => {
			void (async () => {
				if (host.session.isStreaming) {
					host.showStatus("Wait for the current turn before managing the gateway.");
					return;
				}
				if (action === "status") {
					host.showStatus((await import("../../gateway/service.ts")).serviceStatusText());
					return;
				}
				host.ui.stop();
				try {
					await new Promise<void>((resolve, reject) => {
						const child = spawn(process.execPath, [process.argv[1], "gateway", ...action.split(" ")], {
							stdio: "inherit",
							env: process.env,
						});
						child.once("error", reject);
						child.once("exit", (code) =>
							code === 0
								? resolve()
								: reject(new Error(`Gateway command exited with code ${code}. Run lunr gateway doctor.`)),
						);
					});
				} finally {
					host.ui.start();
					host.ui.requestRender(true);
				}
				host.showStatus((await import("../../gateway/service.ts")).serviceStatusText());
			})().catch((error) => host.showStatus(error instanceof Error ? error.message : String(error)));
		},
	} satisfies Partial<SettingsCallbacks>;
}

/** Default permission mode, auto review model and rollback rows. */
function permissionCallbacks(host: SettingsScreenHost, done: () => void) {
	return {
		onDefaultPermissionModeChange: (mode) => {
			host.settingsManager.setDefaultPermissionMode(mode);
		},
		onAutoReviewModelChange: (ref) => {
			host.settingsManager.setAutoReviewModel(ref);
		},
		onChooseAutoReviewModel: () => {
			done();
			host.showAutoReviewModelPicker();
		},
		onRollbackEnabledChange: (enabled) => {
			host.settingsManager.setRollbackEnabled(enabled);
		},
		onRollbackTurnsChange: (turns) => {
			host.settingsManager.setRollbackTurns(turns);
		},
		onRollbackCaptureChange: (mode) => {
			host.settingsManager.setRollbackCapture(mode);
		},
		onRollbackScopeChange: (scope) => {
			host.settingsManager.setRollbackScope(scope);
		},
		isRollbackSessionForceEnabled: () => isRollbackSessionForceEnabled(host.sessionManager.getSessionId()),
	} satisfies Partial<SettingsCallbacks>;
}

/** API key pools, the model tier picker, rendering and closing the screen. */
function subscriptionCallbacks(host: SettingsScreenHost, done: () => void) {
	return {
		// lunr: multi-subscription pool callbacks
		onAutoManageSubscriptionsChange: (enabled) => {
			host.settingsManager.setAutoManageSubscriptions(enabled);
		},
		subscriptions: {
			list: () => listSubscriptionRows(host.session),
			setActive: (providerId, id) => host.session.modelRuntime.subscriptionManager.setActive(providerId, id),
			rename: (providerId, id, name) =>
				host.session.modelRuntime.subscriptionManager.renameKey(providerId, id, name),
			clearExhaustion: (providerId, id) =>
				host.session.modelRuntime.subscriptionManager.clearExhaustion(providerId, id),
			remove: (providerId, id) => host.session.modelRuntime.subscriptionManager.removeKey(providerId, id),
			autoManage: () => host.settingsManager.getAutoManageSubscriptions(),
			requestRender: () => host.ui.requestRender(),
		},
		requestRender: () => host.ui.requestRender(),
		createModelTierPicker: (_tier, currentModelRef, done) => {
			const selector = new ModelSelectorComponent(
				host.ui,
				host.resolveModelReference(currentModelRef),
				host.settingsManager,
				host.session.modelRuntime,
				host.session.scopedModels,
				(model) => {
					done(`${model.provider}/${model.id}`);
					host.ui.requestRender();
				},
				() => {
					done();
					host.ui.requestRender();
				},
				undefined,
				{ persistDefault: false },
			);
			return selector;
		},
		onCancel: () => {
			done();
			host.ui.requestRender();
		},
	} satisfies Partial<SettingsCallbacks>;
}
