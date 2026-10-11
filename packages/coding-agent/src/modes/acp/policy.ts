import type { Settings } from "../../core/settings-manager.ts";

export const ACP_SETTINGS_OVERRIDES = {
	defaultPermissionMode: "yolo",
	automaticSubagentDelegation: false,
	browserEnabled: false,
} satisfies Partial<Settings>;

// exclude factories before initialization so they cannot restore timers or register hooks.
export const ACP_DISABLED_BUILTINS = new Set(["lunr-browser", "lunr-cron", "narumiruna-pi-goal"]);

export const ACP_SCHEDULING_DISABLED = "Scheduled subagents are disabled in ACP sessions. Use the client's scheduler.";
