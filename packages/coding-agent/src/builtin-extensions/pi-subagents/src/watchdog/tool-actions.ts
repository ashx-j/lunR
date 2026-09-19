// @ts-nocheck
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details } from "../shared/types.ts";
import { recommendStrongWatchdogModel, resolveWatchdogModelInput } from "./model-selection.ts";
import { buildWatchdogStatus } from "./register-main.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildRecommendationText(ctx: ExtensionContext): string {
	const recommendation = recommendStrongWatchdogModel(ctx);
	return [
		"Subagent watchdog recommended model",
		`Recommended: ${recommendation.model}:${recommendation.thinking}`,
		`Reason: ${recommendation.reason}`,
		"Watchdog settings are user-managed through /subagents-watchdog.",
	].join("\n");
}

function buildCheckText(runtime: MainWatchdogRuntime | undefined, ctx: ExtensionContext): string {
	if (!runtime) return "Subagent watchdog runtime is unavailable.";
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) return ["Subagent watchdog config check", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	const lines = ["Subagent watchdog config check", "Config: ok"];
	if (snapshot.config.main.model) {
		const resolved = resolveWatchdogModelInput(ctx, snapshot.config.main.model);
		lines.push(`Main model: ${resolved.model} auth ok`);
	} else {
		lines.push("Main model: current session");
	}
	lines.push(`LSP diagnostics: ${snapshot.lsp.enabled ? "on" : "off"} · ${snapshot.lsp.status}`);
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		lines.push(`Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking}`);
	} catch (error) {
		lines.push(`Recommended strong watchdog unavailable: ${messageFromError(error)}`);
	}
	return lines.join("\n");
}

export function handleWatchdogToolAction(action: string, _params: unknown, ctx: ExtensionContext, runtime?: MainWatchdogRuntime): AgentToolResult<Details> {
	try {
		if (action === "watchdog.status") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			return result(buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		}
		if (action === "watchdog.recommend-model") return result(buildRecommendationText(ctx));
		if (action === "watchdog.check") return result(buildCheckText(runtime, ctx));
		return result(`Unknown watchdog action: ${action}`, true);
	} catch (error) {
		return result(`Subagent watchdog action failed: ${messageFromError(error)}`, true);
	}
}

export const WATCHDOG_TOOL_ACTIONS = ["watchdog.status", "watchdog.check", "watchdog.recommend-model"] as const;
