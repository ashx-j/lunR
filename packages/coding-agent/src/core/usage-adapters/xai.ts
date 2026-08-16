/**
 * xAI Grok (SuperGrok / X Premium) weekly plan usage.
 *
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the
 * OAuth access token (Grok CLI identity header required). Official Grok
 * Build `/usage` and grok.com Settings → Usage read the same weekly pool:
 *   config.creditUsagePercent + config.currentPeriod.end
 *
 * Extra Usage Credits (`onDemandCap` > 0) are a secondary window only.
 * `monthlyLimit` / `includedUsed` / `billingPeriodEnd` are the old monthly
 * Extra Usage envelope — never treated as the subscription plan.
 *
 * Pay-as-you-go API keys have no quota endpoint. OAuth-only; any failure
 * or shape mismatch resolves to `undefined` (caller hides the plan section).
 * First-party undocumented protocol — re-smoke against a real OAuth token
 * after xAI changes the billing payload.
 */

import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PlanUsage, PlanUsageWindow } from "../usage-service.ts";
import {
	asObject,
	asString,
	clampPercent,
	fetchWithTimeout,
	toEpochMs,
	unwrapVal,
	usedPercentFromUsed,
} from "./shared.ts";

const XAI_PROVIDER_ID = "xai";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function currentPeriod(config: Record<string, unknown>): Record<string, unknown> | undefined {
	return asObject(config.currentPeriod) ?? asObject(config.current_period);
}

function weeklyWindow(config: Record<string, unknown>): PlanUsageWindow | undefined {
	const period = currentPeriod(config);
	const raw = unwrapVal(config.creditUsagePercent ?? config.credit_usage_percent);
	// Omitted proto3 percent + a live currentPeriod means 0% used (CodexBar).
	if (raw === undefined && !period) return undefined;
	const usedPercent = raw === undefined ? 0 : clampPercent(raw);
	return {
		label: "Weekly",
		usedPercent,
		resetsAt: toEpochMs(period?.end),
	};
}

export async function fetchXaiPlanUsage(runtime: ModelRuntime): Promise<PlanUsage | undefined> {
	if (!runtime.isUsingOAuth(XAI_PROVIDER_ID)) return undefined;

	const resolution = await runtime.getAuth(XAI_PROVIDER_ID);
	const accessToken = resolution?.auth.apiKey;
	if (!accessToken) return undefined;

	const response = await fetchWithTimeout(XAI_BILLING_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"x-xai-token-auth": "xai-grok-cli",
		},
	});
	if (response.status === 401 || response.status === 403) {
		throw new ModelsError("oauth", `xAI billing rejected the session (HTTP ${response.status})`);
	}
	if (!response.ok) return undefined;
	const payload = asObject(await response.json());
	if (!payload) return undefined;
	const config = asObject(payload.config) ?? payload;

	const windows: PlanUsageWindow[] = [];
	const weekly = weeklyWindow(config);
	if (weekly) windows.push(weekly);

	const onDemandCap = unwrapVal(config.onDemandCap);
	if (onDemandCap !== undefined && onDemandCap > 0) {
		const usedPercent = usedPercentFromUsed(onDemandCap, unwrapVal(config.onDemandUsed) ?? 0);
		if (usedPercent !== undefined) {
			windows.push({
				label: "Extra",
				usedPercent,
				resetsAt: weekly?.resetsAt,
			});
		}
	}

	if (windows.length === 0) return undefined;
	const planLabel = asString(config.subscriptionTier) ?? asString(config.subscription_tier);
	return { provider: XAI_PROVIDER_ID, planLabel, windows };
}
