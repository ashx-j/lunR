/**
 * Z.AI (GLM coding plan) usage: `GET https://api.z.ai/api/monitor/usage/quota/limit`
 * with the stored API key. Response shape (undocumented, used by the official
 * plugin and several open-source quota dashboards):
 *   { success, code, msg,
 *     data: { planName?/plan?/level?,
 *             limits: [{ type: "TOKENS_LIMIT"|"TIME_LIMIT", unit, number,
 *                        percentage, nextResetTime? }] } }
 * `unit`: 1 = days, 3 = hours, 5 = minutes, 6 = weeks.
 */

import type { ModelRuntime } from "../model-runtime.ts";
import type { PlanUsage, PlanUsageWindow } from "../usage-service.ts";
import { asNumber, asObject, asString, clampPercent, fetchWithTimeout, toEpochMs } from "./shared.ts";

const ZAI_PROVIDER_ID = "zai";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

function limitLabel(limit: Record<string, unknown>): string | undefined {
	const type = asString(limit.type);
	if (type === "TIME_LIMIT") return "Monthly";
	if (type !== "TOKENS_LIMIT") return undefined;
	const unit = asNumber(limit.unit);
	const number = asNumber(limit.number);
	if (unit === 1 && number !== undefined) return `${number}d`;
	if (unit === 3 && number !== undefined) return `${number}h`;
	if (unit === 5 && number !== undefined) return `${number}m`;
	if (unit === 6) return "Weekly";
	return "Limit";
}

export async function fetchZaiPlanUsage(runtime: ModelRuntime): Promise<PlanUsage | undefined> {
	const resolution = await runtime.getAuth(ZAI_PROVIDER_ID);
	const apiKey = resolution?.auth.apiKey;
	if (!apiKey) return undefined;

	const response = await fetchWithTimeout(ZAI_QUOTA_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Accept-Language": "en-US,en",
		},
	});
	if (!response.ok) return undefined;
	const payload = asObject(await response.json());
	if (!payload || payload.success !== true || asNumber(payload.code) !== 200) return undefined;

	const data = asObject(payload.data);
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const windows: PlanUsageWindow[] = [];
	for (const item of limits) {
		const limit = asObject(item);
		if (!limit) continue;
		const label = limitLabel(limit);
		const percentage = asNumber(limit.percentage);
		if (!label || percentage === undefined) continue;
		windows.push({ label, usedPercent: clampPercent(percentage), resetsAt: toEpochMs(limit.nextResetTime) });
	}
	if (windows.length === 0) return undefined;
	const planLabel = asString(data?.planName) ?? asString(data?.plan) ?? asString(data?.level);
	return { provider: ZAI_PROVIDER_ID, planLabel, windows };
}
