import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearPlanUsageCache, getPlanUsage } from "../src/core/usage-service.ts";
import { formatResetCountdown, renderUsageBox, usageBar } from "../src/modes/interactive/components/usage-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("default", false);

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const CODEX_PAYLOAD = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 71, limit_window_seconds: 18000, reset_at: 1892617800 },
		secondary_window: { used_percent: 14, limit_window_seconds: 604800, reset_at: 1893185400 },
	},
	credits: { has_credits: false, unlimited: true, balance: null },
};

const KIMI_PAYLOAD = {
	usage: { limit: 100, remaining: 29, resetTime: 1893185400000 },
	limits: [
		{
			window: { duration: 5, timeUnit: "hours" },
			detail: { limit: 50, remaining: 15, resetTime: 1892617800000 },
		},
	],
};

const ZAI_PAYLOAD = {
	code: 200,
	msg: "Operation successful",
	data: {
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 15, nextResetTime: 1779792169974 },
		],
		level: "pro",
	},
	success: true,
};

const XAI_PAYLOAD = {
	config: {
		monthlyLimit: { val: 1000 },
		includedUsed: { val: 250 },
		onDemandCap: { val: 100 },
		onDemandUsed: { val: 40 },
		billingPeriodEnd: "2026-08-01T00:00:00Z",
	},
};

interface FakeRuntimeOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	models?: Array<{ provider: string; id: string }>;
}

function fakeRuntime(options: FakeRuntimeOptions = {}): ModelRuntime {
	const hasAuth = options.apiKey !== undefined || options.headers !== undefined;
	return {
		getAuth: async () => (hasAuth ? { auth: { apiKey: options.apiKey, headers: options.headers } } : undefined),
		getModels: () => options.models ?? [],
		getAvailableSnapshot: () => [],
		isUsingOAuth: () => false,
	} as unknown as ModelRuntime;
}

function codexRuntime(): ModelRuntime {
	return fakeRuntime({
		headers: { Authorization: "Bearer codex-oauth-token" },
		models: [{ provider: "openai-codex", id: "gpt-5.3-codex" }],
	});
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
	clearPlanUsageCache();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Adapter normalization
// ---------------------------------------------------------------------------

describe("usage adapters", () => {
	it("normalizes the codex wham/usage payload (weekly first, then 5h)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(CODEX_PAYLOAD)),
		);
		const usage = await getPlanUsage("openai-codex", codexRuntime());
		expect(usage?.provider).toBe("openai-codex");
		expect(usage?.planLabel).toBe("plus");
		expect(usage?.windows).toEqual([
			{ label: "Weekly", usedPercent: 14, resetsAt: 1893185400 * 1000 },
			{ label: "5h", usedPercent: 71, resetsAt: 1892617800 * 1000 },
		]);
	});

	it("sends the resolved OAuth headers to the codex endpoint", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(CODEX_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		await getPlanUsage("openai-codex", codexRuntime());
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer codex-oauth-token");
	});

	it("normalizes the kimi-coding usages payload", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const usage = await getPlanUsage("kimi-coding", fakeRuntime({ apiKey: "kimi-key" }));
		expect(usage?.windows).toEqual([
			{ label: "Weekly", usedPercent: 71, resetsAt: 1893185400000 },
			{ label: "5h", usedPercent: 70, resetsAt: 1892617800000 },
		]);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.kimi.com/coding/v1/usages");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kimi-key");
	});

	it("normalizes the zai quota payload", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(ZAI_PAYLOAD)),
		);
		const usage = await getPlanUsage("zai", fakeRuntime({ apiKey: "zai-key" }));
		expect(usage?.planLabel).toBe("pro");
		expect(usage?.windows).toEqual([
			{ label: "5h", usedPercent: 42, resetsAt: undefined },
			{ label: "Weekly", usedPercent: 15, resetsAt: 1779792169974 },
		]);
	});

	it("normalizes the xai billing payload (protobuf-json { val } wrappers)", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(XAI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const usage = await getPlanUsage("xai", fakeRuntime({ apiKey: "xai-oauth-token" }));
		expect(usage?.windows).toEqual([
			{ label: "Monthly", usedPercent: 25, resetsAt: Date.parse("2026-08-01T00:00:00Z") },
			{ label: "On-demand", usedPercent: 40, resetsAt: Date.parse("2026-08-01T00:00:00Z") },
		]);
		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
	});
});

// ---------------------------------------------------------------------------
// Undefined-on-anything paths
// ---------------------------------------------------------------------------

describe("usage service failure paths", () => {
	it("returns undefined for providers without an adapter", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({})),
		);
		expect(await getPlanUsage("anthropic", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
		expect(await getPlanUsage("ollama-cloud", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
		expect(await getPlanUsage("openrouter", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
	});

	it("returns undefined when no credentials are stored", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		expect(await getPlanUsage("kimi-coding", fakeRuntime())).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns undefined when fetch rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		expect(await getPlanUsage("kimi-coding", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
	});

	it("returns undefined on non-200 responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 401 })),
		);
		expect(await getPlanUsage("zai", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
		expect(await getPlanUsage("xai", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
	});

	it("returns undefined on malformed payloads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not-json", { status: 200 })),
		);
		expect(await getPlanUsage("openai-codex", codexRuntime())).toBeUndefined();
	});

	it("returns undefined when the payload has no displayable windows", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ success: true, code: 200, data: { limits: [] } })),
		);
		expect(await getPlanUsage("zai", fakeRuntime({ apiKey: "k" }))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("usage service cache", () => {
	it("caches results for 5 minutes per provider", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "kimi-key" });
		const first = await getPlanUsage("kimi-coding", runtime);
		const second = await getPlanUsage("kimi-coding", runtime);
		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("also caches failures (no endpoint hammering)", async () => {
		const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "kimi-key" });
		expect(await getPlanUsage("kimi-coding", runtime)).toBeUndefined();
		expect(await getPlanUsage("kimi-coding", runtime)).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refetches after the TTL expires", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "kimi-key" });
		await getPlanUsage("kimi-coding", runtime);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		await getPlanUsage("kimi-coding", runtime);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// /usage box rendering
// ---------------------------------------------------------------------------

describe("renderUsageBox", () => {
	const now = Date.now();
	const data = {
		sessionRows: [{ model: "kimi-coding/k3", input: 24_300_000, output: 83_000, total: 24_400_000 }],
		context: { tokens: 193_000, contextWindow: 1_000_000, percent: 19 },
		plan: {
			provider: "openai-codex",
			planLabel: "plus",
			windows: [
				// +30s buffer: the renderer floors whole minutes at draw time.
				{ label: "Weekly", usedPercent: 14, resetsAt: now + (6 * 24 * 60 + 21 * 60) * 60000 + 30_000 },
				{ label: "5h", usedPercent: 71, resetsAt: now + (2 * 60 + 51) * 60000 + 30_000 },
			],
		},
	};

	it("renders all three sections inside a bordered box", () => {
		const lines = renderUsageBox(data, 120);
		const plain = lines.join("\n");
		expect(plain).toContain("╭ Usage ");
		expect(plain).toContain("Session usage");
		expect(plain).toContain("kimi-coding/k3");
		expect(plain).toContain("input 24M");
		expect(plain).toContain("output 83k");
		expect(plain).toContain("Context window");
		expect(plain).toContain("19%");
		expect(plain).toContain("193k / 1.0M");
		expect(plain).toContain("Plan usage (plus)");
		expect(plain).toContain("14% used");
		expect(plain).toContain("resets in 6d 21h");
		expect(plain).toContain("71% used");
		expect(plain).toContain("resets in 2h 51m");
		expect(lines[lines.length - 1]).toContain("╰");
		// Every line is the same visible width (rectangular box).
		const widths = lines.map((line) => visibleWidth(line));
		expect(new Set(widths).size).toBe(1);
	});

	it("omits the plan section when there is no plan data", () => {
		const lines = renderUsageBox({ ...data, plan: undefined }, 120);
		expect(lines.join("\n")).not.toContain("Plan usage");
	});

	it("truncates content to fit narrow terminals", () => {
		const lines = renderUsageBox(data, 40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("renders a placeholder for an empty session", () => {
		const lines = renderUsageBox({ sessionRows: [], context: undefined, plan: undefined }, 120);
		expect(lines.join("\n")).toContain("No usage data yet.");
	});
});

describe("usage view helpers", () => {
	it("usageBar renders 20 cells proportional to the percent", () => {
		expect(usageBar(0)).toBe("░".repeat(20));
		expect(usageBar(100)).toBe("█".repeat(20));
		expect(usageBar(50)).toBe("█".repeat(10) + "░".repeat(10));
		expect(usageBar(150)).toBe("█".repeat(20));
	});

	it("formatResetCountdown compacts durations", () => {
		const now = Date.now();
		expect(formatResetCountdown(now - 1000, now)).toBe("now");
		expect(formatResetCountdown(now + 45 * 60000, now)).toBe("45m");
		expect(formatResetCountdown(now + (2 * 60 + 51) * 60000, now)).toBe("2h 51m");
		expect(formatResetCountdown(now + (6 * 24 * 60 + 21 * 60) * 60000, now)).toBe("6d 21h");
	});
});
