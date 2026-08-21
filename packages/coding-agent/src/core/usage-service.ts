/**
 * Plan/subscription usage service. Per-provider adapters query provider quota
 * endpoints (60-second cache each) so /usage and the footer can show subscription windows
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
import type { SettingsManager } from "./settings-manager.ts";
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

export const PLAN_USAGE_CACHE_TTL_MS = 60 * 1000;

export type PlanUsageWindowPreference = "5h" | "weekly";

export function isWeeklyPlanWindow(window: PlanUsageWindow): boolean {
	return /week/i.test(window.label);
}

export function isFiveHourPlanWindow(window: PlanUsageWindow): boolean {
	return /5h/i.test(window.label) || window.label === "5h";
}

/** Preferred window, falling back to the other, skipping Extra/on-demand. */
export function pickPlanWindow(
	usage: PlanUsage | undefined,
	preferred: PlanUsageWindowPreference,
): PlanUsageWindow | undefined {
	if (!usage?.windows.length) return undefined;
	const usable = usage.windows.filter((w) => !/extra/i.test(w.label));
	const weekly = usable.find(isWeeklyPlanWindow);
	const fiveH = usable.find(isFiveHourPlanWindow);
	if (preferred === "5h") return fiveH ?? weekly ?? usable[0] ?? usage.windows[0];
	return weekly ?? fiveH ?? usable[0] ?? usage.windows[0];
}

export function footerPlanLabel(window: PlanUsageWindow): string {
	if (isFiveHourPlanWindow(window)) return "5h";
	if (isWeeklyPlanWindow(window)) return "wk";
	return window.label.length <= 4 ? window.label : window.label.slice(0, 4);
}

const cache = new Map<string, { expiresAt: number; value: PlanUsage | undefined }>();
const inflight = new Map<string, Promise<PlanUsageResult>>();

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
	const pending = inflight.get(providerId);
	if (pending) return pending;
	const task = (async (): Promise<PlanUsageResult> => {
		try {
			const value = await adapter(runtime);
			cache.set(providerId, { expiresAt: Date.now() + PLAN_USAGE_CACHE_TTL_MS, value });
			return { usage: value };
		} catch (error) {
			const authError = planUsageAuthError(error);
			if (authError) return { error: authError };
			cache.set(providerId, { expiresAt: Date.now() + PLAN_USAGE_CACHE_TTL_MS, value: undefined });
			return {};
		} finally {
			inflight.delete(providerId);
		}
	})();
	inflight.set(providerId, task);
	return task;
}

/** Last fetched usage, including expired cache (footer can show stale while refetching). */
export function peekPlanUsage(providerId: string): PlanUsage | undefined {
	return cache.get(providerId)?.value;
}

/** Clear the adapter cache (tests, /login changes). */
export function clearPlanUsageCache(): void {
	cache.clear();
	inflight.clear();
}

// ---------------------------------------------------------------------------
// Extension bridge
// ---------------------------------------------------------------------------

export const USAGE_SERVICE_BRIDGE_SYMBOL = Symbol.for("@lunr/usage-service");

export interface FooterPlanSegment {
	label: string;
	usedPercent: number;
}

export interface UsageServiceBridge {
	peek(providerId: string): PlanUsage | undefined;
	prefetch(providerId: string): void;
	getPreferredWindow(): PlanUsageWindowPreference;
	pickForFooter(providerId: string): FooterPlanSegment | undefined;
	setOnUpdate(fn: (() => void) | undefined): void;
}

let activeRuntime: ModelRuntime | undefined;
let activeUsageSettings: SettingsManager | undefined;
let onUsageUpdate: (() => void) | undefined;

function preferredWindow(): PlanUsageWindowPreference {
	return activeUsageSettings?.getPlanUsageWindow() ?? "weekly";
}

const usageBridge: UsageServiceBridge = {
	peek(providerId: string): PlanUsage | undefined {
		return peekPlanUsage(providerId);
	},
	prefetch(providerId: string): void {
		if (!activeRuntime || !hasPlanUsageAdapter(providerId)) return;
		void getPlanUsage(providerId, activeRuntime).then(() => onUsageUpdate?.());
	},
	setOnUpdate(fn: (() => void) | undefined): void {
		onUsageUpdate = fn;
	},
	getPreferredWindow(): PlanUsageWindowPreference {
		return preferredWindow();
	},
	pickForFooter(providerId: string): FooterPlanSegment | undefined {
		const window = pickPlanWindow(peekPlanUsage(providerId), preferredWindow());
		if (!window) return undefined;
		return { label: footerPlanLabel(window), usedPercent: window.usedPercent };
	},
};

export function registerUsageServiceBridge(runtime: ModelRuntime, settingsManager: SettingsManager): void {
	activeRuntime = runtime;
	activeUsageSettings = settingsManager;
	(globalThis as Record<symbol, unknown>)[USAGE_SERVICE_BRIDGE_SYMBOL] = usageBridge;
}

export function getUsageServiceBridge(): UsageServiceBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[USAGE_SERVICE_BRIDGE_SYMBOL] as UsageServiceBridge | undefined;
}
