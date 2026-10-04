import { ModelsError } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStatsLine } from "../src/builtin-extensions/ashxj-tui.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	clearPlanUsageCache,
	footerPlanLabel,
	getAllPlanUsageResults,
	getPlanUsage,
	getPlanUsageResult,
	getUsageServiceBridge,
	peekPlanUsage,
	pickPlanWindow,
	planUsageAuthError,
	registerUsageServiceBridge,
} from "../src/core/usage-service.ts";
import {
	formatResetCountdown,
	renderUsageBox,
	usageBar,
	usageLevelColor,
} from "../src/modes/interactive/components/usage-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

initTheme("moon", false);

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
		creditUsagePercent: 1,
		currentPeriod: { start: "2026-07-29T00:00:00Z", end: "2026-08-05T00:00:00Z" },
		subscriptionTier: "supergrok",
		monthlyLimit: { val: 15000 },
		includedUsed: { val: 2398 },
		onDemandCap: { val: 0 },
		onDemandUsed: { val: 0 },
		billingPeriodEnd: "2026-08-01T00:00:00Z",
	},
};

const XAI_MONTHLY_ONLY_PAYLOAD = {
	config: {
		monthlyLimit: { val: 1000 },
		includedUsed: { val: 250 },
		onDemandCap: { val: 0 },
		billingPeriodEnd: "2026-08-01T00:00:00Z",
	},
};

interface FakeRuntimeOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	models?: Array<{ provider: string; id: string }>;
	oauth?: boolean;
	storedProviders?: string[];
}

function fakeRuntime(options: FakeRuntimeOptions = {}): ModelRuntime {
	const hasAuth = options.apiKey !== undefined || options.headers !== undefined;
	return {
		getAuth: async () => (hasAuth ? { auth: { apiKey: options.apiKey, headers: options.headers } } : undefined),
		getModels: () => options.models ?? [],
		getAvailableSnapshot: () => [],
		isUsingOAuth: () => options.oauth === true,
		listCredentials: async () =>
			(options.storedProviders ?? []).map((providerId) => ({ providerId, type: "api_key" })),
	} as unknown as ModelRuntime;
}

function xaiRuntime(): ModelRuntime {
	return fakeRuntime({ apiKey: "xai-oauth-token", oauth: true });
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

	it("flattens primary and additional Codex rate-limit snapshots", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					...CODEX_PAYLOAD,
					additional_rate_limits: [
						{
							limit_name: "Review",
							metered_feature: "review",
							rate_limit: {
								primary_window: { used_percent: 25, limit_window_seconds: 3600 },
							},
						},
					],
				}),
			),
		);
		const result = await getPlanUsageResult("openai-codex", codexRuntime());
		expect(result.usages).toEqual([
			expect.objectContaining({ provider: "openai-codex", planLabel: "plus" }),
			{
				provider: "openai-codex",
				planLabel: "Review",
				windows: [{ label: "1h", usedPercent: 25, resetsAt: undefined }],
			},
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
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
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

	it("normalizes the xai weekly SuperGrok pool (creditUsagePercent + currentPeriod)", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(XAI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const usage = await getPlanUsage("xai", xaiRuntime());
		expect(usage?.provider).toBe("xai");
		expect(usage?.planLabel).toBe("supergrok");
		expect(usage?.windows).toEqual([
			{ label: "Weekly", usedPercent: 1, resetsAt: Date.parse("2026-08-05T00:00:00Z") },
		]);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		expect((init.headers as Record<string, string>)["x-xai-token-auth"]).toBe("xai-grok-cli");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xai-oauth-token");
	});

	it("treats an omitted creditUsagePercent with a live currentPeriod as 0% used", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					config: { currentPeriod: { end: "2026-08-05T00:00:00Z" }, subscriptionTier: "supergrok" },
				}),
			),
		);
		const usage = await getPlanUsage("xai", xaiRuntime());
		expect(usage?.windows).toEqual([
			{ label: "Weekly", usedPercent: 0, resetsAt: Date.parse("2026-08-05T00:00:00Z") },
		]);
	});

	it("adds an Extra window only when onDemandCap is positive", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					config: {
						...XAI_PAYLOAD.config,
						onDemandCap: { val: 100 },
						onDemandUsed: { val: 40 },
					},
				}),
			),
		);
		const usage = await getPlanUsage("xai", xaiRuntime());
		expect(usage?.windows).toEqual([
			{ label: "Weekly", usedPercent: 1, resetsAt: Date.parse("2026-08-05T00:00:00Z") },
			{ label: "Extra", usedPercent: 40, resetsAt: Date.parse("2026-08-05T00:00:00Z") },
		]);
	});

	it("does not treat the monthly Extra Usage envelope as the SuperGrok plan", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(XAI_MONTHLY_ONLY_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		expect(await getPlanUsage("xai", xaiRuntime())).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not fetch xai billing for API-key (non-OAuth) sessions", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(XAI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		expect(await getPlanUsage("xai", fakeRuntime({ apiKey: "xai-api-key" }))).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
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
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
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
		expect(await getPlanUsage("xai", xaiRuntime())).toBeUndefined();
	});

	it("surfaces a revoked xAI session instead of hiding plan usage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 401 })),
		);
		expect(await getPlanUsageResult("xai", xaiRuntime())).toEqual({
			error: "xAI login expired. Run /login xai.",
		});
		expect(
			planUsageAuthError(
				new ModelsError("oauth", "OAuth refresh failed for xai", {
					cause: new Error("invalid_grant: refresh token revoked"),
				}),
			),
		).toBe("xAI login expired. Run /login xai.");
		expect(planUsageAuthError(new ModelsError("oauth", "OAuth refresh failed for xai"))).toBeUndefined();
		expect(
			planUsageAuthError(new ModelsError("oauth", "xAI billing rejected the session (HTTP 403)")),
		).toBeUndefined();
		expect(planUsageAuthError(new ModelsError("oauth", "OAuth refresh failed for xai: aborted"))).toBeUndefined();
	});

	it("does not cache xAI auth errors as empty plan data", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("nope", { status: 401 }))
			.mockResolvedValueOnce(jsonResponse(XAI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		expect((await getPlanUsageResult("xai", xaiRuntime())).error).toBeDefined();
		expect(await getPlanUsage("xai", xaiRuntime())).toMatchObject({
			provider: "xai",
			planLabel: "supergrok",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
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
// Multi-provider collection
// ---------------------------------------------------------------------------

describe("all plan usage", () => {
	it("fetches stored adapter providers plus the current env-only provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.includes("api.kimi.com")) return jsonResponse(KIMI_PAYLOAD);
				if (url.includes("api.z.ai")) return jsonResponse(ZAI_PAYLOAD);
				if (url.includes("grok.com")) return jsonResponse(XAI_PAYLOAD);
				return new Response("not found", { status: 404 });
			}),
		);
		const result = await getAllPlanUsageResults(
			"xai",
			fakeRuntime({ apiKey: "token", oauth: true, storedProviders: ["kimi-coding", "zai", "openrouter"] }),
		);
		expect(result.usages.map((usage) => usage.provider)).toEqual(["kimi-coding", "zai", "xai"]);
		expect(result.errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("usage service cache", () => {
	it("caches results for 60 seconds per provider", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
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
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "kimi-key" });
		await getPlanUsage("kimi-coding", runtime);
		vi.setSystemTime(Date.now() + 61 * 1000);
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
		sessionTotals: { input: 24_300_000, output: 83_000, total: 24_400_000 },
		context: { tokens: 193_000, contextWindow: 1_000_000, percent: 19 },
		plan: [
			{
				provider: "openai-codex",
				planLabel: "plus",
				windows: [
					// +30s buffer: the renderer floors whole minutes at draw time.
					{ label: "Weekly", usedPercent: 14, resetsAt: now + (6 * 24 * 60 + 21 * 60) * 60000 + 30_000 },
					{ label: "5h", usedPercent: 71, resetsAt: now + (2 * 60 + 51) * 60000 + 30_000 },
				],
			},
		],
	};

	it("renders all three sections inside a bordered box", () => {
		const lines = renderUsageBox(data, 120);
		const plain = lines.join("\n");
		expect(plain).toContain("╭ Usage ");
		expect(plain).toContain("Session usage");
		expect(plain).not.toContain("kimi-coding/k3");
		expect(plain).toContain("input 24M");
		expect(plain).toContain("output 83k");
		expect(plain).toContain("Context window");
		expect(plain).toContain("19%");
		expect(plain).toContain("193k / 1.0M");
		expect(plain).toContain("Plan usage (openai-codex · plus)");
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
		const lines = renderUsageBox({ ...data, plan: [] }, 120);
		expect(lines.join("\n")).not.toContain("Plan usage");
	});

	it("truncates content to fit narrow terminals", () => {
		const lines = renderUsageBox(data, 40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("renders a placeholder for an empty session", () => {
		const lines = renderUsageBox({ sessionTotals: undefined, context: undefined, plan: [] }, 120);
		expect(lines.join("\n")).toContain("No usage data yet.");
	});
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("pickPlanWindow", () => {
	const weekly = { label: "Weekly", usedPercent: 32 };
	const fiveH = { label: "5h", usedPercent: 71 };
	const extra = { label: "Extra", usedPercent: 10 };

	it("prefers 5h and falls back to weekly when 5h is absent", () => {
		expect(pickPlanWindow({ provider: "xai", windows: [weekly] }, "5h")).toEqual(weekly);
		expect(pickPlanWindow({ provider: "openai-codex", windows: [weekly, fiveH] }, "5h")).toEqual(fiveH);
	});

	it("prefers weekly and falls back to 5h", () => {
		expect(pickPlanWindow({ provider: "openai-codex", windows: [weekly, fiveH] }, "weekly")).toEqual(weekly);
		expect(pickPlanWindow({ provider: "openai-codex", windows: [fiveH] }, "weekly")).toEqual(fiveH);
	});

	it("skips Extra windows and returns undefined when empty", () => {
		expect(pickPlanWindow({ provider: "xai", windows: [weekly, extra] }, "weekly")).toEqual(weekly);
		expect(pickPlanWindow({ provider: "xai", windows: [] }, "weekly")).toBeUndefined();
		expect(pickPlanWindow(undefined, "weekly")).toBeUndefined();
	});

	it("labels 5h and weekly compactly", () => {
		expect(footerPlanLabel(fiveH)).toBe("5h");
		expect(footerPlanLabel(weekly)).toBe("wk");
	});
});

describe("usage view helpers", () => {
	it("usageBar renders 20 cells proportional to the percent", () => {
		expect(stripAnsi(usageBar(0))).toBe("░".repeat(20));
		expect(stripAnsi(usageBar(100))).toBe("█".repeat(20));
		expect(stripAnsi(usageBar(50))).toBe("█".repeat(10) + "░".repeat(10));
		expect(stripAnsi(usageBar(150))).toBe("█".repeat(20));
	});

	it("usageLevelColor is green / yellow / red by usage", () => {
		expect(usageLevelColor(0)).toBe("success");
		expect(usageLevelColor(70)).toBe("success");
		expect(usageLevelColor(71)).toBe("warning");
		expect(usageLevelColor(90)).toBe("warning");
		expect(usageLevelColor(91)).toBe("error");
		expect(usageLevelColor(100)).toBe("error");
	});

	it("usageBar colors the fill by usage level", () => {
		expect(usageBar(0)).toBe(theme.fg("dim", "░".repeat(20)));
		expect(usageBar(50)).toBe(theme.fg("success", "█".repeat(10)) + theme.fg("dim", "░".repeat(10)));
		expect(usageBar(71)).toBe(theme.fg("warning", "█".repeat(14)) + theme.fg("dim", "░".repeat(6)));
		expect(usageBar(100)).toBe(theme.fg("error", "█".repeat(20)));
	});

	it("formatResetCountdown compacts durations", () => {
		const now = Date.now();
		expect(formatResetCountdown(now - 1000, now)).toBe("now");
		expect(formatResetCountdown(now + 45 * 60000, now)).toBe("45m");
		expect(formatResetCountdown(now + (2 * 60 + 51) * 60000, now)).toBe("2h 51m");
		expect(formatResetCountdown(now + (6 * 24 * 60 + 21 * 60) * 60000, now)).toBe("6d 21h");
	});
});

describe("usage ownership and invalidation", () => {
	it("isolates two runtimes and their footer peeks", async () => {
		let count = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ ...KIMI_PAYLOAD, usage: { limit: 100, remaining: ++count === 1 ? 90 : 20 } }),
			),
		);
		const first = fakeRuntime({ apiKey: "account-a" });
		const second = fakeRuntime({ apiKey: "account-b" });
		registerUsageServiceBridge(first, SettingsManager.inMemory());
		registerUsageServiceBridge(second, SettingsManager.inMemory());
		await getPlanUsage("kimi-coding", first);
		await getPlanUsage("kimi-coding", second);
		expect(new ModelRegistry(first).getUsageServiceBridge()?.peek("kimi-coding")?.windows[0]?.usedPercent).toBe(10);
		expect(getUsageServiceBridge(second)?.peek("kimi-coding")?.windows[0]?.usedPercent).toBe(80);
		expect(getUsageServiceBridge()).toBeUndefined();
		const render = (runtime: ModelRuntime) =>
			renderStatsLine(
				160,
				{
					mode: "tui",
					hasUI: true,
					ui: { setEditorComponent() {}, setFooter() {} },
					model: { provider: "kimi-coding", id: "fake-model" },
					modelRegistry: new ModelRegistry(runtime),
					sessionManager: { getEntries: () => [] },
					getContextUsage: () => undefined,
				},
				{ fg: (_token, text) => text } as Parameters<typeof renderStatsLine>[2],
				{
					getGitBranch: () => null,
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 0,
					onBranchChange: () => () => {},
				},
			).join("\n");
		expect(render(first)).toContain("10%");
		expect(render(second)).toContain("80%");
	});

	it("changes accounts within a runtime without reusing cached usage", async () => {
		let key = "account-a";
		const runtime = fakeRuntime({ apiKey: key });
		runtime.getAuth = vi.fn(async () => ({ auth: { apiKey: key } }));
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		await getPlanUsage("kimi-coding", runtime);
		key = "account-b";
		await getPlanUsage("kimi-coding", runtime);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer account-b" });
	});

	it("does not restore old usage or remove the new pending request after clear", async () => {
		const replies: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "account-a" });
		const old = getPlanUsage("kimi-coding", runtime);
		await vi.waitFor(() => expect(replies).toHaveLength(1));
		clearPlanUsageCache();
		const current = getPlanUsage("kimi-coding", runtime);
		await vi.waitFor(() => expect(replies).toHaveLength(2));
		replies[0]!(jsonResponse(KIMI_PAYLOAD));
		await old;
		expect(peekPlanUsage("kimi-coding", runtime)).toBeUndefined();
		const joined = getPlanUsage("kimi-coding", runtime);
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		replies[1]!(jsonResponse(KIMI_PAYLOAD));
		expect(await joined).toEqual(await current);
		expect(peekPlanUsage("kimi-coding", runtime)).toEqual(await current);
	});
});

describe("usage account transitions", () => {
	it("coalesces concurrent requests for the same owner and account", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = fakeRuntime({ apiKey: "fake-account" });
		const [first, second] = await Promise.all([
			getPlanUsage("kimi-coding", runtime),
			getPlanUsage("kimi-coding", runtime),
		]);
		expect(second).toEqual(first);
		expect(first).toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("hides old footer usage immediately when a runtime key changes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(KIMI_PAYLOAD)),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ "kimi-coding": { type: "api_key", key: "fake-stored" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		registerUsageServiceBridge(runtime, SettingsManager.inMemory());
		await getPlanUsage("kimi-coding", runtime);
		const bridge = getUsageServiceBridge(runtime)!;
		expect(bridge.peek("kimi-coding")).toBeDefined();
		const transition = runtime.setRuntimeApiKey("kimi-coding", "fake-runtime", { allowNetwork: false });
		expect(bridge.peek("kimi-coding")).toBeUndefined();
		expect(bridge.pickForFooter("kimi-coding")).toBeUndefined();
		await transition;
	});

	it("does not let a late old auth read replace a newer account's footer data", async () => {
		const runtime = fakeRuntime({ apiKey: "fake-account" });
		let resolveOld: ((value: { auth: { apiKey: string } }) => void) | undefined;
		runtime.getAuth = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockResolvedValue({ auth: { apiKey: "fake-new" } });
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse(KIMI_PAYLOAD));
		vi.stubGlobal("fetch", fetchMock);
		const old = getPlanUsage("kimi-coding", runtime);
		const current = await getPlanUsage("kimi-coding", runtime);
		resolveOld!({ auth: { apiKey: "fake-old" } });
		expect(await old).toBeUndefined();
		expect(peekPlanUsage("kimi-coding", runtime)).toEqual(current);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("clears cached footer data when canonical auth fails", async () => {
		const runtime = fakeRuntime({ apiKey: "fake-account" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(KIMI_PAYLOAD)),
		);
		await getPlanUsage("kimi-coding", runtime);
		runtime.getAuth = vi.fn().mockRejectedValue(new Error("fake auth failure"));
		await getPlanUsage("kimi-coding", runtime);
		expect(peekPlanUsage("kimi-coding", runtime)).toBeUndefined();
	});
});
