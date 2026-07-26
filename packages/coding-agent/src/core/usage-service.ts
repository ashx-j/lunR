/**
 * Plan/subscription usage service. Per-provider adapters query provider quota
 * endpoints (5-minute cache each) so /usage and the footer limit bar can show
 * subscription windows alongside pay-per-token cost.
 *
 * Deliberately absent adapters:
 * - anthropic: Anthropic policy prohibits subscription usage tracking in
 *   third-party coding agents (2026-07-18 decision). OAuth Anthropic sessions
 *   fall back to hiding the cost meter.
 * - ollama-cloud: no usage API exists.
 *
 * All adapter/network errors resolve to `undefined` — callers omit the UI.
 */

import type { ModelRuntime } from "./model-runtime.ts";
import { fetchKimiPlanUsage } from "./usage-adapters/kimi-coding.ts";
import { fetchCodexPlanUsage } from "./usage-adapters/openai-codex.ts";
import { fetchXaiPlanUsage } from "./usage-adapters/xai.ts";
import { fetchZaiPlanUsage } from "./usage-adapters/zai.ts";

export interface PlanUsageWindow {
	label: string;
	usedPercent: number;
	/** Epoch ms when the window resets. */
	resetsAt?: number;
}

export interface PlanUsage {
	provider: string;
	planLabel?: string;
	windows: PlanUsageWindow[];
}

type UsageAdapter = (runtime: ModelRuntime) => Promise<PlanUsage | undefined>;

const ADAPTERS: Readonly<Record<string, UsageAdapter>> = {
	"openai-codex": fetchCodexPlanUsage,
	"kimi-coding": fetchKimiPlanUsage,
	zai: fetchZaiPlanUsage,
	xai: fetchXaiPlanUsage,
};

export const PLAN_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { expiresAt: number; value: PlanUsage | undefined }>();

/** Whether a plan-usage adapter exists for this provider. */
export function hasPlanUsageAdapter(providerId: string): boolean {
	return providerId in ADAPTERS;
}

/** Plan usage for a provider, or undefined when unsupported/unavailable. Never throws. */
export async function getPlanUsage(providerId: string, runtime: ModelRuntime): Promise<PlanUsage | undefined> {
	const adapter = ADAPTERS[providerId];
	if (!adapter) return undefined;
	const now = Date.now();
	const cached = cache.get(providerId);
	if (cached && cached.expiresAt > now) return cached.value;
	let value: PlanUsage | undefined;
	try {
		value = await adapter(runtime);
	} catch {
		value = undefined;
	}
	cache.set(providerId, { expiresAt: now + PLAN_USAGE_CACHE_TTL_MS, value });
	return value;
}

/** Clear the adapter cache (tests, /login changes). */
export function clearPlanUsageCache(): void {
	cache.clear();
}

// ---------------------------------------------------------------------------
// Extension bridge
// ---------------------------------------------------------------------------
