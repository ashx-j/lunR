import { afterEach, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { clearPlanUsageCache, registerUsageServiceBridge } from "../src/core/usage-service.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function runtime(apiKey: string): ModelRuntime {
	return {
		getAuth: async () => ({ auth: { apiKey } }),
		isUsingOAuth: () => false,
	} as unknown as ModelRuntime;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	clearPlanUsageCache();
});

it("rebinds usage polling and removes the departing owner's late render callback", async () => {
	vi.useFakeTimers();
	clearPlanUsageCache();
	const first = runtime("fake-first");
	const second = runtime("fake-second");
	registerUsageServiceBridge(first, SettingsManager.inMemory());
	registerUsageServiceBridge(second, SettingsManager.inMemory());
	const pending: Array<(response: Response) => void> = [];
	const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => pending.push(resolve)));
	vi.stubGlobal("fetch", fetch);
	const subject = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: { modelRuntime: first, model: { provider: "kimi-coding" } } },
		ui: { requestRender: vi.fn() },
	}) as {
		runtimeHost: { session: { modelRuntime: ModelRuntime } };
		ui: { requestRender: ReturnType<typeof vi.fn> };
		startPlanUsagePolling(): void;
		stopPlanUsagePolling(): void;
	};
	try {
		subject.startPlanUsagePolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(1);
		subject.stopPlanUsagePolling();
		subject.runtimeHost.session.modelRuntime = second;
		subject.startPlanUsagePolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(2);
		expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer fake-second" });
		const reply = () => new Response(JSON.stringify({ usage: { limit: 100, remaining: 50 } }));
		pending[0]!(reply());
		await vi.advanceTimersByTimeAsync(0);
		expect(subject.ui.requestRender).not.toHaveBeenCalled();
		pending[1]!(reply());
		await vi.advanceTimersByTimeAsync(0);
		expect(subject.ui.requestRender).toHaveBeenCalledTimes(1);
		subject.stopPlanUsagePolling();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(2);
	} finally {
		subject.stopPlanUsagePolling();
	}
});
