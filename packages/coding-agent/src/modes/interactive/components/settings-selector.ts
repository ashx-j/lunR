import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getCustomizeBridge } from "../../../core/customize.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { MEMORY_CHAR_CAP_DEFAULT, MEMORY_CHAR_CAP_MAX, MEMORY_CHAR_CAP_MIN } from "../../../core/memory-cap.ts";
import type { SearchCuratorSetting } from "../../../core/search-curator.ts";
import {
	type DefaultPermissionMode,
	type DefaultProjectTrust,
	type ModelTierName,
	type ModelTiersSettings,
	type RollbackCapture,
	type RollbackScope,
	SKILL_TAG_CHARACTERS,
	type SkillTagCharacter,
} from "../../../core/settings-manager.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	skillTagCharacter: SkillTagCharacter;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	thinkingCollapse: boolean;
	showCacheMissNotices: boolean;
	/** Display value; unset settings render as "short". */
	cacheRetention: "none" | "short" | "long";
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	smoothStreaming: boolean;
	sessionRetentionDays: number;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	modelTiers: ModelTiersSettings;
	memoryEnabled: boolean;
	memoryCharCap: number;
	/** undefined when pi-web-access is not loaded (curator bridge absent). */
	searchCurator: SearchCuratorSetting | undefined;
	// lunr: TUI customize settings
	footerMcp: boolean;
	footerLsp: boolean;
	footerContext: boolean;
	footerTokens: boolean;
	footerCacheHitRate: boolean;
	footerTps: boolean;
	footerStatuses: boolean;
	footerGit: boolean;
	footerPlan: boolean;
	footerPlanBar: boolean;
	planUsageWindow: "5h" | "weekly";
	// lunr: permission mode default
	defaultPermissionMode: DefaultPermissionMode;
	// lunr: rollback settings
	rollbackEnabled: boolean;
	rollbackTurns: number;
	rollbackCapture: RollbackCapture;
	rollbackScope: RollbackScope;
	// lunr: multi-subscription pools
	autoManageSubscriptions: boolean;
	subscriptionCount: number;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSkillTagCharacterChange: (character: SkillTagCharacter) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onThinkingCollapseChange: (collapse: boolean) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCacheRetentionChange: (retention: "none" | "short" | "long") => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onSmoothStreamingChange: (enabled: boolean) => void;
	onSessionRetentionDaysChange: (days: number) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onModelTiersEnabledChange: (enabled: boolean) => void;
	onModelTierModelChange: (tier: ModelTierName, model: string) => void;
	onModelTierThinkingChange: (tier: ModelTierName, level: ThinkingLevel | undefined) => void;
	getTierThinkingLevels: (tier: ModelTierName) => ThinkingLevel[];
	onMemoryEnabledChange: (enabled: boolean) => void;
	onMemoryCharCapChange: (cap: number) => void;
	onSearchCuratorChange: (setting: SearchCuratorSetting) => void;
	// lunr: TUI customize callbacks
	onFooterMcpChange: (enabled: boolean) => void;
	onFooterLspChange: (enabled: boolean) => void;
	onFooterContextChange: (enabled: boolean) => void;
	onFooterTokensChange: (enabled: boolean) => void;
	onFooterCacheHitRateChange: (enabled: boolean) => void;
	onFooterTpsChange: (enabled: boolean) => void;
	onFooterStatusesChange: (enabled: boolean) => void;
	onFooterGitChange: (enabled: boolean) => void;
	onFooterPlanChange: (enabled: boolean) => void;
	onFooterPlanBarChange: (enabled: boolean) => void;
	onPlanUsageWindowChange: (window: "5h" | "weekly") => void;
	// lunr: permission mode default
	onDefaultPermissionModeChange: (mode: DefaultPermissionMode) => void;
	// lunr: rollback callbacks
	onRollbackEnabledChange: (enabled: boolean) => void;
	onRollbackTurnsChange: (turns: number) => void;
	onRollbackCaptureChange: (mode: RollbackCapture) => void;
	onRollbackScopeChange: (scope: RollbackScope) => void;
	isRollbackSessionForceEnabled: () => boolean;
	// lunr: multi-subscription pool callbacks
	onAutoManageSubscriptionsChange: (enabled: boolean) => void;
	/** lunr: live pool accessors; when absent the Subscriptions row is hidden. */
	subscriptions?: SubscriptionCallbacks;
	/** Open the model picker for a tier; done() receives the selected "provider/model" string, or no value on cancel. */
	createModelTierPicker: (
		tier: ModelTierName,
		currentModel: string | undefined,
		done: (selectedValue?: string) => void,
	) => Component;
	onCancel: () => void;
}

const MODEL_TIER_ROWS: { tier: ModelTierName; label: string; description: string }[] = [
	{
		tier: "light",
		label: "Light tier model",
		description: "Fast, low-cost model for simple subagent tasks",
	},
	{
		tier: "standard",
		label: "Standard tier model",
		description: "Balanced model for everyday coding tasks",
	},
	{
		tier: "heavy",
		label: "Heavy tier model",
		description: "Strong model for complex reasoning and debugging",
	},
];

/**
 * Submenu for the 3-tier subagent model routing (light/standard/heavy).
 * Row 1 toggles tier mode; rows 2-4 open a model picker per tier.
 */
class ModelTiersSubmenu extends Container {
	private settingsList: SettingsList;
	private state: {
		enabled: boolean;
		light?: string;
		standard?: string;
		heavy?: string;
		lightThinking?: ThinkingLevel;
		standardThinking?: ThinkingLevel;
		heavyThinking?: ThinkingLevel;
	};

	constructor(
		currentValue: string | undefined,
		modelTiers: ModelTiersSettings,
		callbacks: SettingsCallbacks,
		done: (selectedValue?: string) => void,
	) {
		super();

		this.state = {
			enabled: currentValue === "on" || (currentValue === undefined && (modelTiers.enabled ?? false)),
			light: modelTiers.light,
			standard: modelTiers.standard,
			heavy: modelTiers.heavy,
			lightThinking: modelTiers.lightThinking,
			standardThinking: modelTiers.standardThinking,
			heavyThinking: modelTiers.heavyThinking,
		};

		const thinkingKey = (tier: ModelTierName): "lightThinking" | "standardThinking" | "heavyThinking" =>
			tier === "light" ? "lightThinking" : tier === "standard" ? "standardThinking" : "heavyThinking";

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Enable model tiers",
				description: "Route subagent work by model tier",
				currentValue: this.state.enabled ? "on" : "off",
				values: ["on", "off"],
			},
			...MODEL_TIER_ROWS.flatMap((row): SettingItem[] => {
				const tier = row.tier;
				const tKey = thinkingKey(tier);
				return [
					{
						id: tier,
						label: row.label,
						description: row.description,
						currentValue: this.state[tier] ?? "not set",
						disabled: () => !this.state.enabled,
						submenu: (_currentValue, done) => callbacks.createModelTierPicker(tier, this.state[tier], done),
					},
					{
						id: `${tier}-thinking`,
						label: `${row.label.replace(" model", "")} thinking`,
						description: "Reasoning level for this tier",
						currentValue: this.state[tKey] ?? "inherit",
						disabled: () => !this.state.enabled,
						submenu: (_currentValue, done) =>
							new SelectSubmenu(
								`${row.label} thinking`,
								"Inherit uses the parent session's reasoning level",
								[
									{
										value: "inherit",
										label: "inherit",
										description: "Use the parent session's reasoning level",
									},
									...callbacks.getTierThinkingLevels(tier).map((level) => ({
										value: level,
										label: level,
										description: THINKING_DESCRIPTIONS[level],
									})),
								],
								this.state[tKey] ?? "inherit",
								(value) => {
									callbacks.onModelTierThinkingChange(
										tier,
										value === "inherit" ? undefined : (value as ThinkingLevel),
									);
									done(value);
								},
								() => done(),
							),
					},
				];
			}),
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "enabled") {
					this.state.enabled = newValue === "on";
					callbacks.onModelTiersEnabledChange(this.state.enabled);
					return;
				}
				if (id.endsWith("-thinking")) {
					const tier = id.slice(0, -"-thinking".length) as ModelTierName;
					const tKey = thinkingKey(tier);
					this.state[tKey] = newValue === "inherit" ? undefined : (newValue as ThinkingLevel);
					return;
				}
				const tier = id as ModelTierName;
				this.state[tier] = newValue;
				callbacks.onModelTierModelChange(tier, newValue);
			},
			() => done(this.state.enabled ? "on" : "off"),
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/**
 * Numeric input submenu for the simple-pi-memory character cap.
 * Enter validates and applies via done(newValue); Esc cancels.
 */
class MemoryCharCapSubmenu extends Container {
	private input: Input;
	private errorText: Text;

	constructor(currentValue: string, done: (selectedValue?: string) => void) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", "Memory Character Cap")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Maximum agent memory size (${MEMORY_CHAR_CAP_MIN} to ${MEMORY_CHAR_CAP_MAX} characters, default ${MEMORY_CHAR_CAP_DEFAULT})`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(currentValue);
		this.input.onSubmit = (value) => {
			const n = Number(value.trim());
			if (!Number.isInteger(n) || n < MEMORY_CHAR_CAP_MIN || n > MEMORY_CHAR_CAP_MAX) {
				this.errorText.setText(
					theme.fg("error", `  Enter an integer between ${MEMORY_CHAR_CAP_MIN} and ${MEMORY_CHAR_CAP_MAX}.`),
				);
				return;
			}
			done(String(n));
		};
		this.input.onEscape = () => done();
		this.addChild(this.input);

		this.errorText = new Text("", 0, 0);
		this.addChild(this.errorText);
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

const SEARCH_CURATOR_VALUES: SearchCuratorSetting[] = ["off", "on", "auto-summary"];

// lunr: Customize submenu — toggles for the lunR TUI customize settings.
class CustomizeSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(_config: SettingsConfig, callbacks: SettingsCallbacks, done: (selectedValue?: string) => void) {
		super();

		// Read live values from the customize bridge so re-entering the submenu within
		// one /settings session reflects toggles made earlier in that session.
		const bridge = getCustomizeBridge();
		const items: SettingItem[] = [
			{
				id: "footer-mcp",
				label: "MCP status",
				description: "MCP server status",
				currentValue: (bridge?.getFooterMcp() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-lsp",
				label: "LSP status",
				description: "Language server status",
				currentValue: (bridge?.getFooterLsp() ?? false) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-context",
				label: "Context meter",
				description: "Context usage",
				currentValue: (bridge?.getFooterContext() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-tokens",
				label: "Token counter",
				description: "Input and output token counts",
				currentValue: (bridge?.getFooterTokens() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-cache-hit-rate",
				label: "Cache hit rate",
				description: "Latest prompt cache hit rate",
				currentValue: (bridge?.getFooterCacheHitRate() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-tps",
				label: "TPS counter",
				description: "Token generation speed",
				currentValue: (bridge?.getFooterTps() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-statuses",
				label: "Feature statuses",
				description: "Active plan, goal, and swarm status",
				currentValue: (bridge?.getFooterStatuses() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-git",
				label: "Git branch",
				description: "Git branch and line changes",
				currentValue: (bridge?.getFooterGit() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-plan",
				label: "Plan usage",
				description: "Subscription usage percentage",
				currentValue: (bridge?.getFooterPlan() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "footer-plan-bar",
				label: "Plan bar",
				description: "Bar beside the subscription usage percentage",
				currentValue: (bridge?.getFooterPlanBar() ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "footer-mcp":
						callbacks.onFooterMcpChange(newValue === "on");
						break;
					case "footer-lsp":
						callbacks.onFooterLspChange(newValue === "on");
						break;
					case "footer-context":
						callbacks.onFooterContextChange(newValue === "on");
						break;
					case "footer-tokens":
						callbacks.onFooterTokensChange(newValue === "on");
						break;
					case "footer-cache-hit-rate":
						callbacks.onFooterCacheHitRateChange(newValue === "on");
						break;
					case "footer-tps":
						callbacks.onFooterTpsChange(newValue === "on");
						break;
					case "footer-statuses":
						callbacks.onFooterStatusesChange(newValue === "on");
						break;
					case "footer-git":
						callbacks.onFooterGitChange(newValue === "on");
						break;
					case "footer-plan":
						callbacks.onFooterPlanChange(newValue === "on");
						break;
					case "footer-plan-bar":
						callbacks.onFooterPlanBarChange(newValue === "on");
						break;
				}
			},
			() => done(),
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

// lunr: Rollback submenu — enable, turns, capture mode, scope.
class RollbackSubmenu extends Container {
	private settingsList: SettingsList;
	private enabled: boolean;

	constructor(
		currentValue: string | undefined,
		config: SettingsConfig,
		callbacks: SettingsCallbacks,
		sessionForceEnabled: boolean,
		done: (selectedValue?: string) => void,
	) {
		super();

		this.enabled = currentValue === "on" || (currentValue === undefined && config.rollbackEnabled);

		const items: SettingItem[] = [
			{
				id: "rollback-enabled",
				label: "Rollback enabled",
				description: `Save file snapshots for /rollback${sessionForceEnabled ? ". Always on in Auto mode" : ""}`,
				currentValue: this.enabled ? "on" : "off",
				values: ["on", "off"],
				disabled: () => sessionForceEnabled,
			},
			{
				id: "rollback-turns",
				label: "Rollback turns",
				description: "Number of turns kept for rollback",
				currentValue: String(config.rollbackTurns),
				disabled: () => !this.enabled,
				submenu: (currentValue, submenuDone) => new RollbackTurnsSubmenu(currentValue, submenuDone),
			},
			{
				id: "rollback-capture",
				label: "Capture mode",
				description: "How rollback snapshots are stored",
				currentValue: config.rollbackCapture,
				disabled: () => !this.enabled,
				submenu: (currentValue, submenuDone) =>
					new SelectSubmenu(
						"Rollback Capture Mode",
						"Snapshot storage method",
						[
							{
								value: "copies",
								label: "copies",
								description: "File copies for tool edits and created files",
							},
							{
								value: "hybrid",
								label: "hybrid",
								description: "Track files created outside tools with tree scope",
							},
							{
								value: "shadow-git",
								label: "shadow-git",
								description: "Reserved mode; currently falls back to copies",
							},
						],
						currentValue,
						(value) => {
							callbacks.onRollbackCaptureChange(value as RollbackCapture);
							submenuDone(value);
						},
						() => submenuDone(),
					),
			},
			{
				id: "rollback-scope",
				label: "Rollback scope",
				description: "Which file changes rollback tracks",
				currentValue: config.rollbackScope,
				disabled: () => !this.enabled,
				submenu: (currentValue, submenuDone) =>
					new SelectSubmenu(
						"Rollback Scope",
						"File changes included in snapshots",
						[
							{ value: "tools", label: "tools", description: "Changes made by edit and write tools" },
							{
								value: "tree",
								label: "tree",
								description: "Tool and shell changes across the repository",
							},
						],
						currentValue,
						(value) => {
							callbacks.onRollbackScopeChange(value as RollbackScope);
							submenuDone(value);
						},
						() => submenuDone(),
					),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "rollback-enabled":
						this.enabled = newValue === "on";
						callbacks.onRollbackEnabledChange(this.enabled);
						break;
				}
			},
			() => done(this.enabled ? "on" : "off"),
		);
		this.addChild(new Text(theme.bold(theme.fg("accent", "Rollback")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.settingsList);
		this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class RollbackTurnsSubmenu extends Container {
	private input: Input;
	private errorText: Text;

	constructor(currentValue: string, done: (selectedValue?: string) => void) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Rollback Turns")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Number of turns kept for rollback (1 to 20, default 2)"), 0, 0));
		this.addChild(new Spacer(1));
		this.input = new Input();
		this.input.setValue(currentValue);
		this.input.onSubmit = (value) => {
			const n = Number(value.trim());
			if (!Number.isInteger(n) || n < 1 || n > 20) {
				this.errorText.setText(theme.fg("error", "  Enter an integer between 1 and 20."));
				return;
			}
			done(String(n));
		};
		this.input.onEscape = () => done();
		this.addChild(this.input);
		this.errorText = new Text("", 0, 0);
		this.addChild(this.errorText);
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

// lunr: one subscription pool entry, passed as plain data so render paths stay synchronous.
export interface SubscriptionRowInfo {
	providerId: string;
	providerName: string;
	id: string;
	name: string;
	active: boolean;
	exhaustedUntil?: number;
}

// lunr: live accessors for the subscription pool, wired by interactive-mode.
export interface SubscriptionCallbacks {
	list: () => Promise<SubscriptionRowInfo[]>;
	setActive: (providerId: string, id: string) => Promise<void>;
	rename: (providerId: string, id: string, name: string) => Promise<void>;
	clearExhaustion: (providerId: string, id: string) => Promise<void>;
	remove: (providerId: string, id: string) => Promise<void>;
	autoManage: () => boolean;
	requestRender: () => void;
}

// lunr: format an exhaustion timestamp — local HH:mm when it ends today, else a short date.
export function formatSubscriptionExhaustedUntil(exhaustedUntil: number, now: number = Date.now()): string {
	const date = new Date(exhaustedUntil);
	if (date.toDateString() === new Date(now).toDateString()) {
		return date.toTimeString().slice(0, 5);
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// lunr: free-text rename prompt for a subscription key (same Input pattern as MemoryCharCapSubmenu).
class SubscriptionRenameSubmenu extends Container {
	private input: Input;
	private errorText: Text;

	constructor(currentName: string, done: (selectedValue?: string) => void) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Rename Subscription")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Display name for this API key."), 0, 0));
		this.addChild(new Spacer(1));
		this.input = new Input();
		this.input.setValue(currentName);
		this.input.onSubmit = (value) => {
			const name = value.trim();
			if (!name) {
				this.errorText.setText(theme.fg("error", "  Enter a non-empty name."));
				return;
			}
			done(name);
		};
		this.input.onEscape = () => done();
		this.addChild(this.input);
		this.errorText = new Text("", 0, 0);
		this.addChild(this.errorText);
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

// lunr: per-subscription actions — set active, rename, clear exhaustion, remove.
// onChanged asks the parent SubscriptionsSubmenu to reload its rows from the live manager.
class SubscriptionActionSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(
		row: SubscriptionRowInfo,
		subs: SubscriptionCallbacks,
		done: (selectedValue?: string) => void,
		onChanged: () => void,
	) {
		super();

		const items: SettingItem[] = [
			{
				id: "set-active",
				label: "Set active",
				description: subs.autoManage()
					? "Turn off automatic key rotation to switch keys"
					: "Use this key for new requests",
				currentValue: row.active ? "already active" : "activate",
				values: ["activate"],
				disabled: () => subs.autoManage() || row.active,
			},
			{
				id: "rename",
				label: "Rename",
				description: "Change the key's display name",
				currentValue: row.name,
				submenu: (currentValue, renameDone) =>
					new SubscriptionRenameSubmenu(currentValue, (name) => {
						if (name === undefined) {
							renameDone();
							return;
						}
						void subs.rename(row.providerId, row.id, name).then(() => {
							renameDone(name);
							done();
							onChanged();
						});
					}),
			},
			{
				id: "clear-exhaustion",
				label: "Clear exhausted flag",
				description:
					row.exhaustedUntil !== undefined
						? `Marked exhausted until ${formatSubscriptionExhaustedUntil(row.exhaustedUntil)}.`
						: "Unavailable until the key is marked exhausted",
				currentValue: "clear",
				values: ["clear"],
				disabled: () => row.exhaustedUntil === undefined,
			},
			{
				id: "remove",
				label: "Remove",
				description: "Delete this stored key",
				currentValue: "remove…",
				submenu: (_currentValue, confirmDone) =>
					new SelectSubmenu(
						"Remove Subscription",
						`Delete "${row.name}" from ${row.providerName}? The last key also logs out the provider.`,
						[
							{ value: "cancel", label: "Cancel" },
							{ value: "remove", label: "Remove key" },
						],
						"cancel",
						(value) => {
							if (value !== "remove") {
								confirmDone();
								return;
							}
							void subs.remove(row.providerId, row.id).then(() => {
								confirmDone();
								done();
								onChanged();
							});
						},
						() => confirmDone(),
					),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				if (id === "set-active") {
					void subs.setActive(row.providerId, row.id).then(() => {
						done();
						onChanged();
					});
				} else if (id === "clear-exhaustion") {
					void subs.clearExhaustion(row.providerId, row.id).then(() => {
						done();
						onChanged();
					});
				}
			},
			() => done(),
		);

		this.addChild(new Text(theme.bold(theme.fg("accent", `${row.providerName} — ${row.name}`)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

// lunr: Subscriptions submenu — one row per pooled API key across all providers.
// Rows reload from the live manager on open and after every mutation.
class SubscriptionsSubmenu extends Container {
	private readonly subs: SubscriptionCallbacks;
	private readonly done: (selectedValue?: string) => void;
	private contentContainer: Container;
	private settingsList: SettingsList | undefined;
	private closed = false;

	constructor(subs: SubscriptionCallbacks, done: (selectedValue?: string) => void) {
		super();
		this.subs = subs;
		this.done = done;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Subscriptions")), 0, 0));
		this.addChild(new Spacer(1));
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		this.contentContainer.addChild(new Text(theme.fg("muted", "  Loading…"), 0, 0));
		void this.reload();
	}

	private async reload(): Promise<void> {
		let rows: SubscriptionRowInfo[] = [];
		try {
			rows = await this.subs.list();
		} catch {
			rows = [];
		}
		if (this.closed) return;

		this.contentContainer.clear();
		this.settingsList = undefined;

		if (rows.length === 0) {
			this.contentContainer.addChild(new Text(theme.fg("muted", "  No stored API key subscriptions."), 0, 0));
			this.contentContainer.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			this.subs.requestRender();
			return;
		}

		const items: SettingItem[] = rows.map((row) => ({
			id: `${row.providerId}/${row.id}`,
			label: `${row.providerName} — ${row.name}`,
			description:
				`${row.providerId} API key` +
				(row.exhaustedUntil !== undefined
					? ` · exhausted until ${formatSubscriptionExhaustedUntil(row.exhaustedUntil)}`
					: ""),
			currentValue: row.active ? "active" : row.exhaustedUntil !== undefined ? "exhausted" : "",
			submenu: (_currentValue, subDone) =>
				new SubscriptionActionSubmenu(row, this.subs, subDone, () => void this.reload()),
		}));

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			() => {},
			// Closing reports the current count so the parent row label stays fresh.
			() => this.done(`${rows.length} key${rows.length === 1 ? "" : "s"}`),
		);
		this.contentContainer.addChild(this.settingsList);
		this.subs.requestRender();
	}

	handleInput(data: string): void {
		if (this.settingsList) {
			this.settingsList.handleInput(data);
			return;
		}
		// Loading/empty state: only Esc goes back.
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.closed = true;
			this.done();
		}
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "Automatic",
			description: "Follow the terminal's light or dark appearance",
		},
		...themeItems(availableThemes),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "moon");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"moon",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Choose a theme or follow terminal appearance",
			singleModeThemeItems(this.availableThemes),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Use different themes for light and dark terminals."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme for light terminals",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("Light Theme", "Theme for light terminals", currentValue, done, (value) => {
						this.lightTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme for dark terminals",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("Dark Theme", "Theme for dark terminals", currentValue, done, (value) => {
						this.darkTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save theme settings",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Use one theme for all terminal appearances",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const curatorAvailable = config.searchCurator !== undefined;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Compact context before it reaches the model limit",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description: "How new messages interrupt a streaming response",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `How ${followUpKey} messages run after the current response`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Connection method for supported providers",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description: "Time before an inactive HTTP request times out",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Thinking block visibility",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				// lunr: collapsible reasoning — completed thinking runs render as
				// "✻ Thought for Xs" + first sentence. Disabled when thinking is hidden.
				id: "thinking-collapse",
				label: "Collapse thinking",
				description: "Short summaries for completed thinking",
				currentValue: config.thinkingCollapse ? "true" : "false",
				values: ["true", "false"],
				disabled: () => config.hideThinkingBlock,
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Prompt cache miss notices in the transcript",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				// lunr: unset settings stay undefined so PI_CACHE_RETENTION still
				// applies; the row displays "short" as the implicit default.
				id: "cache-retention",
				label: "Cache retention",
				description: "Prompt cache lifetime",
				currentValue: config.cacheRetention,
				values: ["short", "long", "none"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Startup log visibility",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "smooth-streaming",
				label: "Smooth streaming",
				description: "Typewriter-style response streaming",
				currentValue: config.smoothStreaming ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "agent-memory",
				label: "Agent memory",
				description: "Durable facts the agent can manage",
				currentValue: config.memoryEnabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "memory-char-cap",
				label: "Memory character cap",
				description: "Maximum agent memory size",
				currentValue: String(config.memoryCharCap),
				submenu: (currentValue, submenuDone) => new MemoryCharCapSubmenu(currentValue, submenuDone),
			},
			{
				id: "search-curator",
				label: "Search curator",
				description: curatorAvailable
					? "Web search review and summary mode"
					: "Unavailable because web access is not loaded",
				currentValue: config.searchCurator ?? "unavailable",
				values: curatorAvailable ? SEARCH_CURATOR_VALUES : undefined,
			},
			{
				id: "session-retention-days",
				label: "Session retention",
				description: "How long session files are kept",
				currentValue: String(config.sessionRetentionDays),
				values: ["0", "7", "14", "30", "60", "90", "365"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Trust choice when a project has no saved decision",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "default-permission-mode",
				label: "Default permission mode",
				description: "Starting permission mode for new sessions",
				currentValue: config.defaultPermissionMode,
				values: ["manual", "yolo", "plan", "auto"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action for double Escape in an empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default /tree filter",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning level for supported models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Reasoning level for supported models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Interface color theme",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
			{
				id: "model-tiers",
				label: "Model tiers",
				description: "Subagent model routing",
				currentValue: config.modelTiers.enabled ? "on" : "off",
				submenu: (currentValue, done) => new ModelTiersSubmenu(currentValue, config.modelTiers, callbacks, done),
			},
			{
				id: "plan-usage-window",
				label: "Plan usage window",
				description: "Subscription usage period shown in the footer",
				currentValue: config.planUsageWindow,
				values: ["5h", "weekly"],
			},
			// lunr: Customize submenu — lunR TUI toggles (rail, prompt symbol, footer segments)
			{
				id: "customize",
				label: "Customize",
				description: "Interface and footer options",
				currentValue: "configure",
				submenu: (_currentValue, done) => new CustomizeSubmenu(config, callbacks, done),
			},
			// lunr: Rollback submenu
			{
				id: "rollback",
				label: "Rollback",
				description: "Rollback behavior options",
				currentValue: config.rollbackEnabled ? "on" : "off",
				submenu: (currentValue, done) =>
					new RollbackSubmenu(currentValue, config, callbacks, callbacks.isRollbackSessionForceEnabled(), done),
			},
			// lunr: multi-subscription pools
			{
				id: "auto-manage-subscriptions",
				label: "Auto-manage subscriptions",
				description: "Automatic API key rotation after usage limits",
				currentValue: config.autoManageSubscriptions ? "on" : "off",
				values: ["on", "off"],
			},
		];

		// lunr: Subscriptions submenu — one row per pooled API key (live manager accessors).
		const subscriptionCallbacks = callbacks.subscriptions;
		if (subscriptionCallbacks) {
			items.push({
				id: "subscriptions",
				label: "Subscriptions",
				description: "Saved API key management",
				currentValue:
					config.subscriptionCount === 0
						? "none"
						: `${config.subscriptionCount} key${config.subscriptionCount === 1 ? "" : "s"}`,
				submenu: (_currentValue, done) => new SubscriptionsSubmenu(subscriptionCallbacks, done),
			});
		}

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Inline terminal image rendering",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Limit images to 2000 x 2000 pixels",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from reaching model providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill tag character (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "skill-tag-character",
			label: "Skill tag",
			description: "After a space, this character lists skills to tag in the message",
			currentValue: config.skillTagCharacter,
			values: [...SKILL_TAG_CHARACTERS],
		});

		// Hardware cursor toggle (insert after skill-tag-character)
		const skillTagIndex = items.findIndex((item) => item.id === "skill-tag-character");
		items.splice(skillTagIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Terminal cursor for input method editors",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal editor padding",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "Horizontal message padding",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Visible autocomplete items",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear leftover terminal rows when content shrinks",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Progress in supported terminal tabs",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "skill-tag-character":
						callbacks.onSkillTagCharacterChange(newValue as SkillTagCharacter);
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "thinking-collapse":
						callbacks.onThinkingCollapseChange(newValue === "true");
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "cache-retention":
						callbacks.onCacheRetentionChange(newValue as "none" | "short" | "long");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "smooth-streaming":
						callbacks.onSmoothStreamingChange(newValue === "true");
						break;
					case "plan-usage-window":
						callbacks.onPlanUsageWindowChange(newValue === "5h" ? "5h" : "weekly");
						break;
					case "memory-char-cap":
						callbacks.onMemoryCharCapChange(parseInt(newValue, 10));
						break;
					case "agent-memory":
						callbacks.onMemoryEnabledChange(newValue === "on");
						break;
					case "search-curator":
						callbacks.onSearchCuratorChange(newValue as SearchCuratorSetting);
						break;
					case "session-retention-days":
						callbacks.onSessionRetentionDaysChange(parseInt(newValue, 10));
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "default-permission-mode":
						callbacks.onDefaultPermissionModeChange(newValue as DefaultPermissionMode);
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "auto-manage-subscriptions":
						callbacks.onAutoManageSubscriptionsChange(newValue === "on");
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
