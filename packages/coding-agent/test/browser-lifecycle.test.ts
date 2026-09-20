import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), enabled: false }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../src/core/install-features.ts", () => ({
	isFeatureEnabled: () => mocks.enabled,
	getFeatureOption: () => false,
}));

import browserExtension from "../src/builtin-extensions/lunr-browser.ts";
import { BrowserSession } from "../src/core/browser/runtime.ts";

afterEach(() => {
	vi.clearAllMocks();
	mocks.enabled = false;
});

describe("browser lifecycle", () => {
	it("registers only when explicitly enabled and never launches during registration", () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		const api = { registerTool, on } as unknown as ExtensionAPI;
		browserExtension(api);
		expect(registerTool).not.toHaveBeenCalled();
		mocks.enabled = true;
		browserExtension(api);
		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "browser" }));
		expect(on.mock.calls.map(([event]) => event)).toEqual(["session_shutdown", "session_start", "agent_end"]);
		expect(mocks.launch).not.toHaveBeenCalled();
	});
	it("reports missing Chromium without installing and allows a later retry", async () => {
		mocks.launch.mockRejectedValue(new Error("Executable doesn't exist"));
		const session = new BrowserSession(true);
		try {
			await expect(session.run({ action: "navigate", url: "http://127.0.0.1" })).rejects.toThrow(
				"Nothing was installed",
			);
			await expect(session.run({ action: "navigate", url: "http://127.0.0.1" })).rejects.toThrow(
				"lunr features enable browser",
			);
			expect(mocks.launch).toHaveBeenCalledTimes(2);
		} finally {
			await session.close();
		}
	});
	it("closes a browser whose launch completes after cancellation", async () => {
		let release: (browser: unknown) => void = () => {};
		const close = vi.fn(async () => {});
		mocks.launch.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const session = new BrowserSession(true);
		const controller = new AbortController();
		const running = session.run({ action: "navigate", url: "http://127.0.0.1" }, controller.signal);
		const assertion = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());
		controller.abort();
		release({
			close,
			newContext: async () => ({
				setDefaultTimeout() {},
				setDefaultNavigationTimeout() {},
				route: async () => {},
				routeWebSocket: async () => {},
				on() {},
			}),
		});
		await assertion;
		await session.close();
		expect(close).toHaveBeenCalledOnce();
	});
	it("shutdown invalidates deferred extension initialization", async () => {
		mocks.enabled = true;
		const registerTool = vi.fn();
		const on = vi.fn();
		browserExtension({ registerTool, on } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls[0][0];
		const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
		const running = tool.execute("call", { action: "navigate", url: "http://127.0.0.1" });
		await shutdown();
		await expect(running).rejects.toThrow("cancelled");
		expect(mocks.launch).not.toHaveBeenCalled();
	});
});
