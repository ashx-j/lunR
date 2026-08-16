/**
 * Plan/subscription usage service. Per-provider adapters query provider quota
 * endpoints (5-minute cache each) so /usage can show subscription windows
 * alongside session/context totals.
 *
 * Deliberately absent adapters:
 * - anthropic: Anthropic policy prohibits subscription usage tracking in
 *   third-party coding agents (2026-07-18 decision). OAuth Anthropic sessions
 *   fall back to hiding the cost meter.
 * - ollama-cloud: no usage API exists.
 *
 * Adapter/network errors resolve to `undefined` (callers omit the plan UI).
 * Auth failures are different: they return `error` and are not cached as empty.
 */

import { ModelsError } from "@earendil-works/pi-ai";
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

export interface PlanUsageResult {
	usage?: PlanUsage;
	/** Actionable auth failure. Not cached as an empty success. */
	error?: string;
}

const XAI_RELOGIN = "xAI login expired. Run /login xai.";

function errorChain(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(current.message);
			current = current.cause;
			continue;
		}
		break;
	}
	return parts.join(" ");
}

/** Classify adapter/getAuth failures that mean the SuperGrok session is dead. */
export function planUsageAuthError(error: unknown): string | undefined {
	const chain = errorChain(error);
	if (/timed out|aborted|cancelled|ECONN|ENOTFOUND|network/i.test(chain)) return undefined;
	// 403 on billing is often entitlement, not a dead refresh token.
	if (/xai billing rejected the session \(HTTP 401\)/i.test(chain)) return XAI_RELOGIN;
	if (/invalid_grant|refresh token revoked/i.test(chain)) return XAI_RELOGIN;
	return undefined;
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
	return (await getPlanUsageResult(providerId, runtime)).usage;
}

/** Like getPlanUsage, but surfaces SuperGrok/auth failures instead of hiding them. */
export async function getPlanUsageResult(providerId: string, runtime: ModelRuntime): Promise<PlanUsageResult> {
	const adapter = ADAPTERS[providerId];
	if (!adapter) return {};
	const now = Date.now();
	const cached = cache.get(providerId);
	if (cached && cached.expiresAt > now) return { usage: cached.value };
	try {
		const value = await adapter(runtime);
		cache.set(providerId, { expiresAt: now + PLAN_USAGE_CACHE_TTL_MS, value });
		return { usage: value };
	} catch (error) {
		const authError = planUsageAuthError(error);
		if (authError) return { error: authError };
		cache.set(providerId, { expiresAt: now + PLAN_USAGE_CACHE_TTL_MS, value: undefined });
		return {};
	}
}

/** Clear the adapter cache (tests, /login changes). */
export function clearPlanUsageCache(): void {
	cache.clear();
}

// ---------------------------------------------------------------------------
// Extension bridge
// ---------------------------------------------------------------------------
