/**
 * Shared helpers for plan-usage adapters: timed fetch, tolerant JSON field
 * accessors, and epoch normalization. Adapters never throw — callers turn any
 * failure into `undefined`.
 */

export const DEFAULT_USAGE_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number = DEFAULT_USAGE_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Parse a reset timestamp in epoch seconds, epoch ms, or ISO-8601 form to epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
	const asNumberValue = asNumber(value);
	if (asNumberValue !== undefined) {
		// Below ~ Sep 2001 in ms it's almost certainly epoch seconds.
		return asNumberValue < 1e12 ? Math.round(asNumberValue * 1000) : Math.round(asNumberValue);
	}
	const asStringValue = asString(value);
	if (asStringValue) {
		const parsed = Date.parse(asStringValue);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** Unwrap protobuf-json style `{ val: n }` wrappers (xAI billing responses). */
export function unwrapVal(value: unknown): number | undefined {
	const object = asObject(value);
	if (object && "val" in object) return asNumber(object.val);
	return asNumber(value);
}

/** Used % from limit/remaining pairs; undefined when either side is missing or limit is 0. */
export function usedPercentFromRemaining(limit: unknown, remaining: unknown): number | undefined {
	const total = asNumber(limit);
	const left = asNumber(remaining);
	if (total === undefined || left === undefined || total <= 0) return undefined;
	return clampPercent(100 - (left / total) * 100);
}

/** Used % from total/used pairs; undefined when either side is missing or total is 0. */
export function usedPercentFromUsed(total: unknown, used: unknown): number | undefined {
	const cap = asNumber(total);
	const spent = asNumber(used);
	if (cap === undefined || spent === undefined || cap <= 0) return undefined;
	return clampPercent((spent / cap) * 100);
}
