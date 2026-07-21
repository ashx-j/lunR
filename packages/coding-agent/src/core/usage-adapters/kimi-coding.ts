/**
 * Kimi for Coding plan usage: `GET https://api.kimi.com/coding/v1/usages`
 * with the stored API key (Bearer). Response shape (undocumented, mirrors
 * other open-source quota dashboards):
 *   { usage: { limit, remaining, resetTime },
 *     limits: [{ window: { duration, timeUnit }, detail: { limit, remaining, resetTime } }] }
 */

import type { ModelRuntime } from "../model-runtime.ts";
import type { PlanUsage, PlanUsageWindow } from "../usage-service.ts";
import { asNumber, asObject, fetchWithTimeout, toEpochMs, usedPercentFromRemaining } from "./shared.ts";

const KIMI_PROVIDER_ID = "kimi-coding";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

const TIME_UNIT_SECONDS: Record<string, number> = {
	seconds: 1,
	second: 1,
	minutes: 60,
	minute: 60,
	hours: 3600,
	hour: 3600,
	days: 86400,
	day: 86400,
	weeks: 604800,
	week: 604800,
};

function durationLabel(duration: unknown, timeUnit: unknown): string {
	const amount = asNumber(duration);
	const unit = typeof timeUnit === "string" ? timeUnit.toLowerCase() : undefined;
	const seconds = amount !== undefined && unit ? TIME_UNIT_SECONDS[unit] : undefined;
	if (amount === undefined || seconds === undefined) return "Limit";
	const totalSeconds = amount * seconds;
	if (totalSeconds >= 604800) return "Weekly";
	if (totalSeconds >= 86400) return `${Math.round(totalSeconds / 86400)}d`;
	if (totalSeconds >= 3600) return `${Math.round(totalSeconds / 3600)}h`;
	return `${Math.max(1, Math.round(totalSeconds / 60))}m`;
}

function detailWindow(label: string, detail: unknown): PlanUsageWindow | undefined {
	const object = asObject(detail);
	if (!object) return undefined;
	const usedPercent = usedPercentFromRemaining(object.limit, object.remaining);
	if (usedPercent === undefined) return undefined;
	return { label, usedPercent, resetsAt: toEpochMs(object.resetTime) };
}

export async function fetchKimiPlanUsage(runtime: ModelRuntime): Promise<PlanUsage | undefined> {
	const resolution = await runtime.getAuth(KIMI_PROVIDER_ID);
	const apiKey = resolution?.auth.apiKey;
	if (!apiKey) return undefined;

	const response = await fetchWithTimeout(KIMI_USAGE_URL, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	if (!response.ok) return undefined;
	const payload = asObject(await response.json());
	if (!payload) return undefined;

	const windows: PlanUsageWindow[] = [];
	// Top-level `usage` is the weekly quota; `limits[]` carries the short rate window.
	const weekly = detailWindow("Weekly", payload.usage);
	if (weekly) windows.push(weekly);
	const limits = Array.isArray(payload.limits) ? payload.limits : [];
	for (const item of limits) {
		const limit = asObject(item);
		if (!limit) continue;
		const window = detailWindow(
			durationLabel(asObject(limit.window)?.duration, asObject(limit.window)?.timeUnit),
			limit.detail,
		);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;
	return { provider: KIMI_PROVIDER_ID, windows };
}
