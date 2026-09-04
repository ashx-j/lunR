// @ts-nocheck
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SETTINGS_BRIDGE = Symbol.for("@lunr/settings-tools");
const MODEL_TIERS_BRIDGE = Symbol.for("@lunr/model-tiers");

export const DETAILED_SETTINGS_TOOL_NAMES = [
	"settings_model_tiers",
	"settings_subscriptions",
	"settings_rollback",
	"settings_session_retention",
] as const;

function settingsBridge(): any {
	const bridge = (globalThis as Record<symbol, unknown>)[SETTINGS_BRIDGE];
	if (!bridge) throw new Error("Settings are unavailable in this runtime. Reload lunR and try again.");
	return bridge;
}

function text(value: unknown, guidance: string) {
	return {
		content: [{ type: "text" as const, text: `${JSON.stringify(value, null, 2)}\n\n${guidance}` }],
		details: value,
	};
}

const thinking = Type.Union([
	Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
	Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"), Type.Null(),
], { description: "Per-tier thinking level. null inherits the parent session thinking level." });

export default function lunrSettingsTools(pi: ExtensionAPI): void {
	let loaded = false;

	const registerDetailedTools = () => {
		if (loaded) return;
		loaded = true;

		pi.registerTool({
			name: "settings_model_tiers",
			label: "Model tiers",
			description: "Read or partially update light, standard, and heavy subagent model routes and their thinking levels. Models use provider/model ids. Omitted fields are unchanged.",
			parameters: Type.Object({
				enabled: Type.Optional(Type.Boolean({ description: "Enable or disable tier-based child routing." })),
				light: Type.Optional(Type.String({ minLength: 1, description: "Model route for light work." })),
				standard: Type.Optional(Type.String({ minLength: 1, description: "Model route for standard work." })),
				heavy: Type.Optional(Type.String({ minLength: 1, description: "Model route for heavy work." })),
				lightThinking: Type.Optional(thinking),
				standardThinking: Type.Optional(thinking),
				heavyThinking: Type.Optional(thinking),
			}, { additionalProperties: false }),
			async execute(_id, params) {
				const bridge = settingsBridge();
				if (Object.keys(params).length > 0) {
					bridge.setModelTiers(params);
					(globalThis as Record<symbol, any>)[MODEL_TIERS_BRIDGE]?.refreshToolDescription?.();
				}
				return text(bridge.getModelTiers(), Object.keys(params).length > 0
					? "Tier routes are saved and apply to the next child launch; the subagent schema guidance is refreshed now."
					: "Pass only the fields you want to change. Child launches still validate model availability and authentication.");
			},
		});

		pi.registerTool({
			name: "settings_subscriptions",
			label: "Subscription management",
			description: "Read or update automatic management of multiple stored provider subscriptions. Omit enabled to read without changing it.",
			parameters: Type.Object({ enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
			async execute(_id, params) {
				const bridge = settingsBridge();
				if (params.enabled !== undefined) bridge.setAutoManageSubscriptions(params.enabled);
				return text({ enabled: bridge.getAutoManageSubscriptions() }, params.enabled === undefined
					? "Set enabled to change automatic subscription selection."
					: "The setting is saved and applies to subsequent provider requests.");
			},
		});

		pi.registerTool({
			name: "settings_rollback",
			label: "Rollback",
			description: "Read or partially update rollback behavior: enabled, retained turns, capture strategy, and scope. Omitted fields are unchanged. Auto permission mode force-enables rollback for its current session.",
			parameters: Type.Object({
				enabled: Type.Optional(Type.Boolean()),
				turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
				capture: Type.Optional(Type.Union([Type.Literal("copies"), Type.Literal("shadow-git"), Type.Literal("hybrid")])),
				scope: Type.Optional(Type.Union([Type.Literal("tools"), Type.Literal("tree")])),
			}, { additionalProperties: false }),
			async execute(_id, params) {
				const bridge = settingsBridge();
				if (Object.keys(params).length > 0) bridge.setRollback(params);
				const current = bridge.getRollback();
				return text(current, current.forcedByAuto
					? "Saved settings apply normally, but rollback remains force-enabled for this Auto-mode session."
					: Object.keys(params).length > 0 ? "Rollback settings are saved and live for subsequent tool calls." : "Pass only the fields you want to change.");
			},
		});

		pi.registerTool({
			name: "settings_session_retention",
			label: "Session retention",
			description: "Read or update how many days saved sessions are retained. Set days to 0 to keep sessions forever. Cleanup applies on a later launch, not retroactively in this turn.",
			parameters: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 0, maximum: 36500 })) }, { additionalProperties: false }),
			async execute(_id, params) {
				const bridge = settingsBridge();
				if (params.days !== undefined) bridge.setSessionRetentionDays(params.days);
				return text({ days: bridge.getSessionRetentionDays() }, params.days === undefined
					? "Set days to change retention; 0 keeps sessions forever."
					: "The setting is saved. Session cleanup uses it on a later launch.");
			},
		});
	};

	pi.registerTool({
		name: "settings_load",
		label: "Settings",
		description: "Load four narrow agent-managed settings tools for model tiers, subscription management, rollback, and session retention. Call only when the task requires inspecting or changing those settings.",
		promptSnippet: "Load narrow settings controls on demand",
		promptGuidelines: ["Call settings_load only when the user asks to inspect or change model tiers, subscription management, rollback, or session retention."],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const alreadyLoaded = loaded;
			registerDetailedTools();
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...DETAILED_SETTINGS_TOOL_NAMES])]);
			return text(
				{ activated: [...DETAILED_SETTINGS_TOOL_NAMES], alreadyLoaded },
				"The four tools are active for the next model step and remain active in this runtime. A new runtime starts with only settings_load visible.",
			);
		},
	});
}
