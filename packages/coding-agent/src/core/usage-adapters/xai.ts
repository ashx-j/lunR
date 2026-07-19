/**
 * xAI Grok (SuperGrok / Grok Build subscription) usage:
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the OAuth
 * access token. The billing payload is protobuf-json style (`{ val: number }`
 * wrappers); only the included-monthly and on-demand credit windows are read.
 * Pay-as-you-go API keys have no quota endpoint — any failure or shape mismatch
 * resolves to `undefined` (the caller then hides the plan section).
 */

import type { ModelRuntime } from "../model-runtime.ts";
import type { PlanUsage, PlanUsageWindow } from "../usage-service.ts";
import { asObject, asString, fetchWithTimeout, toEpochMs, unwrapVal, usedPercentFromUsed } from "./shared.ts";

const XAI_PROVIDER_ID = "xai";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export async function fetchXaiPlanUsage(runtime: ModelRuntime): Promise<PlanUsage | undefined> {
	const resolution = await runtime.getAuth(XAI_PROVIDER_ID);
	const accessToken = resolution?.auth.apiKey;
	if (!accessToken) return undefined;

	const response = await fetchWithTimeout(XAI_BILLING_URL, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
	});
	if (!response.ok) return undefined;
	const payload = asObject(await response.json());
	if (!payload) return undefined;
	const config = asObject(payload.config) ?? payload;

	const resetsAt =
		toEpochMs(config.billingPeriodEnd) ??
		toEpochMs(config.billing_period_end) ??
		toEpochMs(asObject(config.currentPeriod)?.end);

	const windows: PlanUsageWindow[] = [];
	const monthlyLimit = unwrapVal(config.monthlyLimit ?? config.monthly_limit);
	if (monthlyLimit !== undefined && monthlyLimit > 0) {
		const used =
			unwrapVal(config.includedUsed ?? config.included_used) ?? unwrapVal(config.totalUsed ?? config.total_used);
		const usedPercent = usedPercentFromUsed(monthlyLimit, used ?? 0);
		if (usedPercent !== undefined) windows.push({ label: "Monthly", usedPercent, resetsAt });
	}
	const onDemandCap = unwrapVal(config.onDemandCap);
	if (onDemandCap !== undefined && onDemandCap > 0) {
		const usedPercent = usedPercentFromUsed(onDemandCap, unwrapVal(config.onDemandUsed) ?? 0);
		if (usedPercent !== undefined) windows.push({ label: "On-demand", usedPercent, resetsAt });
	}
	if (windows.length === 0) return undefined;
	const planLabel = asString(config.subscriptionTier) ?? asString(config.subscription_tier);
	return { provider: XAI_PROVIDER_ID, planLabel, windows };
}
