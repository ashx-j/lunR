import { beforeAll, describe, expect, it } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const config: SettingsConfig = {
	autoCompact: true,
	showImages: false,
	imageWidthCells: 60,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	skillTagCharacter: "$",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "sse",
	httpIdleTimeoutMs: 300_000,
	thinkingLevel: "medium",
	availableThinkingLevels: ["off", "low", "medium", "high"],
	currentTheme: "moon",
	terminalTheme: "dark",
	availableThemes: ["moon"],
	hideThinkingBlock: false,
	thinkingCollapse: false,
	reasoningDisplay: "auto",
	showCacheMissNotices: false,
	cacheRetention: "short",
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	showHardwareCursor: false,
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	smoothStreaming: true,
	subagentSpinner: "braille",
	sessionRetentionDays: 30,
	defaultProjectTrust: "ask",
	clearOnShrink: false,
	showTerminalProgress: true,
	attentionNotification: "off",
	modelTiers: {},
	modelInstructions: { enabled: false, mode: "both" },
	globalInstructionsPath: "/tmp/AGENTS.md",
	modelInstructionsPath: "/tmp/models",
	confirmLargeSubagentLaunches: false,
	clientScopedModelsOnly: false,
	subagentCommunicationEnabled: true,
	automaticSubagentDelegation: true,
	browserEnabled: false,
	memoryEnabled: true,
	memoryCharCap: 4000,
	todosEnabled: true,
	searchCurator: undefined,
	footerMcp: true,
	footerLsp: true,
	footerContext: true,
	footerTokens: true,
	footerCacheHitRate: true,
	footerTps: true,
	footerStatuses: true,
	footerGit: true,
	footerPlan: true,
	footerPlanBar: true,
	planUsageWindow: "5h",
	defaultPermissionMode: "yolo",
	autoReviewModel: undefined,
	rollbackEnabled: true,
	rollbackTurns: 10,
	rollbackCapture: "copies",
	rollbackScope: "tools",
	autoManageSubscriptions: false,
	subscriptionCount: 0,
};

// Records every callback call as "name:args". The selector only calls callbacks after input.
function createSelector() {
	const calls: string[] = [];
	const callbacks = new Proxy(
		{},
		{
			get: (_target, name) =>
				name === "subscriptions"
					? undefined
					: (...args: unknown[]) => calls.push(`${String(name)}:${args.join(",")}`),
		},
	) as SettingsCallbacks;
	return { selector: new SettingsSelectorComponent({ ...config }, callbacks), calls };
}

describe("settings selector Advanced submenu", () => {
	beforeAll(() => initTheme("moon"));

	it("applies a change made inside Advanced once", () => {
		const { selector, calls } = createSelector();
		const list = selector.getSettingsList();
		list.handleInput("\x1b[A");
		expect(selector.render(100).some((line) => line.includes("Advanced"))).toBe(true);
		list.handleInput("\r");
		expect(selector.render(100).some((line) => line.includes("Transport"))).toBe(true);

		list.handleInput("\r");
		expect(calls).toEqual(["onTransportChange:websocket"]);
	});

	it("finds Advanced rows from top-level search and opens the submenu", () => {
		const { selector } = createSelector();
		const list = selector.getSettingsList();
		list.handleInput("padding");
		const results = selector.render(100);
		expect(results.some((line) => line.includes("Advanced") && line.includes("Editor padding, Output padding"))).toBe(
			true,
		);
		expect(results.some((line) => line.includes("No matching settings"))).toBe(false);

		list.handleInput("\r");
		expect(selector.render(100).some((line) => line.includes("Clear on shrink"))).toBe(true);
	});
});
