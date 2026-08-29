// Vendored from narumiruna-pi-codex-usage (deleted in Phase 1 of the lunr-ux plan):
// the pi-auth HTTP query path of `query.ts` plus `normalize.ts` and the backend
// types from `types.ts`, consolidated into one core module. The codex app-server
// fallback was dropped; extension-API imports (ExtensionContext, modelRegistry)
// were rewired to core's ModelRuntime. No runtime dependency on the deleted
// extension or on extension-repos remains.

import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PlanUsage, PlanUsageWindow } from "../usage-service.ts";
import { asNumber, asObject, asString, fetchWithTimeout, toEpochMs } from "./shared.ts";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_ERROR_BODY_CHARS = 600;

// ---------------------------------------------------------------------------
// Backend payload types (vendored from types.ts)
// ---------------------------------------------------------------------------

type RateLimitStatusPayload = {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
	rate_limit_reset_credits?: unknown;
};

type BackendRateLimitDetails = {
	primary_window?: unknown;
	secondary_window?: unknown;
};

type BackendWindowSnapshot = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
};

type BackendAdditionalRateLimit = {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
};

type BackendCreditsSnapshot = {
	has_credits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
};

type NormalizedWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type NormalizedSnapshot = {
	limitId: string;
	limitName?: string;
	primary?: NormalizedWindow;
	secondary?: NormalizedWindow;
};

type CodexUsageReport = {
	planType?: string;
	snapshots: NormalizedSnapshot[];
};

// ---------------------------------------------------------------------------
// Payload normalization (vendored from normalize.ts, backend path only)
// ---------------------------------------------------------------------------

function normalizeBackendPayload(payload: RateLimitStatusPayload): CodexUsageReport {
	const snapshots: NormalizedSnapshot[] = [];
	const planType = asString(payload.plan_type);
	const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit, payload.credits);
	if (primary) snapshots.push(primary);

	const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
	for (const item of additional) {
		const additionalLimit = asObject(item) as BackendAdditionalRateLimit | undefined;
		if (!additionalLimit) continue;
		const limitId = asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
		if (!limitId) continue;
		try {
			const snapshot = normalizeBackendSnapshot(
				limitId,
				asString(additionalLimit.limit_name),
				additionalLimit.rate_limit,
				undefined,
			);
			if (snapshot) snapshots.push(snapshot);
		} catch {
			// Optional additional buckets must not hide otherwise usable primary usage.
		}
	}

	if (snapshots.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable usage data.");
	}
	return { planType, snapshots };
}

function normalizeBackendSnapshot(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
	credits: unknown,
): NormalizedSnapshot | undefined {
	if (rateLimit === null || rateLimit === undefined) {
		return normalizeBackendCredits(credits) ? { limitId, limitName } : undefined;
	}
	const details = asObject(rateLimit) as BackendRateLimitDetails | undefined;
	if (!details) throw new Error("rate limit was not an object.");
	const primary = normalizeBackendWindow(details.primary_window);
	const secondary = normalizeBackendWindow(details.secondary_window);
	if (!primary && !secondary && !normalizeBackendCredits(credits)) return undefined;
	return { limitId, limitName, primary, secondary };
}

function normalizeBackendWindow(value: unknown): NormalizedWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = asObject(value) as BackendWindowSnapshot | undefined;
	if (!window) throw new Error("rate-limit window was not an object.");
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitSeconds = asNumber(window.limit_window_seconds);
	return {
		usedPercent,
		windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
		resetsAt: toEpochMs(window.reset_at),
	};
}

function normalizeBackendCredits(value: unknown): boolean {
	const credits = asObject(value) as BackendCreditsSnapshot | undefined;
	if (!credits) return false;
	return credits.has_credits !== undefined && credits.unlimited !== undefined;
}

// ---------------------------------------------------------------------------
// Auth resolution via core ModelRuntime (rewired from ctx.modelRegistry)
// ---------------------------------------------------------------------------

async function resolveCodexHeaders(runtime: ModelRuntime): Promise<Record<string, string> | undefined> {
	const candidates: Model<Api>[] = [];
	const seen = new Set<string>();
	const add = (model: Model<Api> | undefined) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};
	for (const model of runtime.getAvailableSnapshot()) add(model);
	for (const model of runtime.getModels()) add(model);

	for (const model of candidates) {
		let resolution: AuthResult | undefined;
		try {
			resolution = await runtime.getAuth(model);
		} catch {
			continue;
		}
		if (!resolution) continue;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(resolution.auth.headers ?? {})) {
			if (value !== null && value !== undefined) headers[name] = String(value);
		}
		if (!hasHeader(headers, "Authorization") && resolution.auth.apiKey) {
			headers.Authorization = `Bearer ${resolution.auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "lunr-usage-service";
		}
		if (hasHeader(headers, "Authorization")) return headers;
	}
	return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function redactErrorBody(body: string): string {
	const redacted = body
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
		.trim();
	return redacted.length > MAX_ERROR_BODY_CHARS ? `${redacted.slice(0, MAX_ERROR_BODY_CHARS - 1)}…` : redacted;
}

// ---------------------------------------------------------------------------
// PlanUsage mapping
// ---------------------------------------------------------------------------

function windowLabel(window: NormalizedWindow, fallback: string | undefined): string {
	const minutes = window.windowMinutes;
	if (minutes === undefined) return fallback ?? "Limit";
	if (minutes >= 7 * 24 * 60) return "Weekly";
	if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}d`;
	if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
	return `${minutes}m`;
}

function toPlanUsage(report: CodexUsageReport): PlanUsage[] {
	return report.snapshots.flatMap((snapshot, index) => {
		// Longer window (weekly) first, shorter (5h) second — matches /usage layout.
		const windows: PlanUsageWindow[] = [];
		for (const window of [snapshot.secondary, snapshot.primary]) {
			if (!window) continue;
			windows.push({
				label: windowLabel(window, snapshot.limitName),
				usedPercent: window.usedPercent,
				resetsAt: window.resetsAt,
			});
		}
		if (windows.length === 0) return [];
		return [
			{
				provider: CODEX_PROVIDER_ID,
				planLabel: index === 0 ? report.planType : (snapshot.limitName ?? snapshot.limitId),
				windows,
			},
		];
	});
}

export async function fetchCodexPlanUsage(runtime: ModelRuntime): Promise<PlanUsage[] | undefined> {
	const headers = await resolveCodexHeaders(runtime);
	if (!headers) return undefined;

	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers });
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Codex usage endpoint returned ${response.status}: ${redactErrorBody(text)}`);
	}
	const payload = asObject(JSON.parse(text)) as RateLimitStatusPayload | undefined;
	if (!payload) return undefined;
	return toPlanUsage(normalizeBackendPayload(payload));
}
