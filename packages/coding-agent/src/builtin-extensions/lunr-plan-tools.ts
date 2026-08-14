// @ts-nocheck
/**
 * lunr-plan-tools — lunR-native plan-approval tool for plan mode.
 *
 * lunR: this file is lunR-native (not an absorbed upstream extension).
 *
 *  - One `present_plan` tool (TypeBox): the model calls it with a plan summary
 *    while plan mode is active; the user approves or declines in a dedicated
 *    dialog (kind "plan" approval request, see core/permissions.ts). Any
 *    approve exits plan mode in interactive-mode BEFORE the result resolves.
 *  - Outside plan mode the tool returns an error text. Without an approval
 *    handler (gateway/headless) it passes through instead of deadlocking.
 *  - Chat render is a quiet one-liner (renderCall/renderResult), matching the
 *    todo/cron tools' minimal footprint.
 *
 * `runPresentPlan` is exported for vitest — see test/plan-approval.test.ts.
 *
 * `// @ts-nocheck` matches the builtin-extension convention (see lunr-cron).
 * Runtime imports stay on concrete core modules — never the package barrel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { requestPlanApproval } from "../core/permissions.ts";
import { isPlanModeActive } from "../core/plan-mode.ts";

export const PRESENT_PLAN_WRONG_MODE_TEXT = "present_plan is only available in plan mode.";

/** Execute-body logic, exported for tests: gate on plan mode, then ask. */
export async function runPresentPlan(summary: string): Promise<string> {
	if (!isPlanModeActive()) return PRESENT_PLAN_WRONG_MODE_TEXT;
	return requestPlanApproval(summary);
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "present_plan",
		label: "Plan",
		description: [
			"Present the finished plan for user approval. Only available in plan mode.",
			"Call once with a concise, concrete summary of the plan; the user approves",
			"or declines it in a dialog. The result text says whether to implement or revise.",
		].join("\n"),
		parameters: Type.Object({
			summary: Type.String({ description: "Concise summary of the plan to approve." }),
		}),
		async execute(_toolCallId, params) {
			const summary = typeof params?.summary === "string" ? params.summary.trim() : "";
			return { content: [{ type: "text" as const, text: await runPresentPlan(summary) }] };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("present_plan")), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Presenting plan..."), 0, 0);
			const first = result?.content?.[0];
			const text = first?.type === "text" ? first.text : "";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	});
}
