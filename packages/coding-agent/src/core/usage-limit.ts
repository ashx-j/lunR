/**
 * Provider error classification for subscription-key rotation.
 *
 * lunr: these classify provider free-text error bodies — regex-on-English,
 * so wording drift across providers (or upstream changes to error text) can
 * silently reclassify an error. Treat matches as heuristics, not contracts.
 */

const USAGE_LIMIT_ERROR_PATTERNS = [
	// Provider-declared subscription/free-tier limit error types and wording
	// (pi-ai NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN spirit).
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
] as const;

const USAGE_LIMIT_ERROR_REGEXES = [
	// Goal runtime USAGE_LIMIT_GOAL_ERROR_PATTERNS: usage caps, quota exhaustion,
	// credit/balance exhaustion, payment required.
	/usage[_\s-]*(?:limit|cap)|chatgpt.{0,32}usage/i,
	/quota.{0,32}(?:reached|exceeded|exhausted|depleted)|(?:reached|exceeded|exhausted|depleted).{0,32}quota/i,
	/insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|payment required/i,
	/(?:credit|balance).{0,32}(?:low|exhausted|depleted)|billing/i,
] as const;

const AUTH_INVALID_ERROR_PATTERN =
	/\b401\b|unauthori[sz]ed|unauthenticated|invalid.{0,16}(?:api.?key|token|credentials?)|authentication.{0,16}failed/i;

export function isUsageLimitError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (USAGE_LIMIT_ERROR_PATTERNS.some((pattern) => errorMessage.toLowerCase().includes(pattern.toLowerCase()))) {
		return true;
	}
	return USAGE_LIMIT_ERROR_REGEXES.some((pattern) => pattern.test(errorMessage));
}

export function isAuthInvalidError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	return AUTH_INVALID_ERROR_PATTERN.test(errorMessage);
}

const RESET_TIME_PATTERNS = [
	/reset(?:s|ting)?\s*(?:in|after|at)?\s*(\d+)\s*s(ec)?/i,
	/reset(?:s|ting)?\s*(?:in|after|at)?\s*(\d+)\s*m(in)?/i,
	/reset(?:s|ting)?\s*(?:in|after|at)?\s*(\d+)\s*h(our|r)?/i,
	/(?:retry|try(?:\s+again)?|available)\s+(?:in|after|at)\s*(\d+)\s*s(ec)?/i,
	/(?:retry|try(?:\s+again)?|available)\s+(?:in|after|at)\s*(\d+)\s*m(in)?/i,
	/(?:retry|try(?:\s+again)?|available)\s+(?:in|after|at)\s*(\d+)\s*h(our|r)?/i,
] as const;

/**
 * Parse a quota-reset time out of an error message: relative forms like
 * "reset in 2h" / "retry in 30m" / "available in 3600s", or an ISO-8601
 * timestamp. Returns epoch ms in the future, or undefined when unparseable.
 * Port of the goal runtime's parseUsageResetTimeMs.
 */
export function parseResetTimeMs(errorMessage: string): number | undefined {
	if (!errorMessage) return undefined;
	const now = Date.now();
	for (const pattern of RESET_TIME_PATTERNS) {
		const match = errorMessage.match(pattern);
		if (!match) continue;
		const value = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isFinite(value) || value <= 0) continue;
		const unit = pattern.source.includes("\\s*h") ? 3600_000 : pattern.source.includes("\\s*m") ? 60_000 : 1_000;
		return now + value * unit;
	}
	// ISO-8601 timestamp fallback (e.g. "reset at 2026-08-01T09:00:00Z").
	const isoMatch = errorMessage.match(
		/(?:reset|available).{0,12}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
	);
	if (isoMatch?.[1]) {
		const parsed = Date.parse(isoMatch[1]);
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	return undefined;
}
