import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), enabled: true, changed: (_enabled: boolean) => {} }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../src/core/browser/settings.ts", () => ({
	readBrowserSettings: () => ({ enabled: mocks.enabled, allowPrivate: false }),
	onBrowserEnabledChange: (listener: (enabled: boolean) => void) => {
		mocks.changed = listener;
		return () => {};
	},
}));

import browserExtension from "../src/builtin-extensions/lunr-browser.ts";
import { BrowserSession } from "../src/core/browser/runtime.ts";

afterEach(() => {
	vi.clearAllMocks();
	mocks.enabled = true;
});

describe("browser lifecycle", () => {
	it("registers lazily by default and never launches during registration", () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		const api = { registerTool, on } as unknown as ExtensionAPI;
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
				"lunr browser install",
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
	it("disabling Browser closes an active browser", async () => {
		let opened = (_page: unknown) => {};
		const page = { on() {}, url: () => "about:blank" };
		const close = vi.fn(async () => {});
		mocks.launch.mockResolvedValue({
			close,
			newContext: async () => ({
				setDefaultTimeout() {},
				setDefaultNavigationTimeout() {},
				route: async () => {},
				routeWebSocket: async () => {},
				on: (_event: string, listener: typeof opened) => {
					opened = listener;
				},
				newPage: async () => {
					opened(page);
					return page;
				},
			}),
		});
		const registerTool = vi.fn();
		const on = vi.fn();
		browserExtension({ registerTool, on } as unknown as ExtensionAPI);
		await on.mock.calls.find(([event]) => event === "session_start")?.[1]();
		await registerTool.mock.calls[0][0].execute("call", { action: "tabs", operation: "create" });
		mocks.changed(false);
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		await on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]();
	});
	it("disabling Browser invalidates initialization and blocks further calls", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		browserExtension({ registerTool, on } as unknown as ExtensionAPI);
		await on.mock.calls.find(([event]) => event === "session_start")?.[1]();
		const tool = registerTool.mock.calls[0][0];
		const running = tool.execute("call", { action: "navigate", url: "http://127.0.0.1" });
		mocks.changed(false);
		await expect(running).rejects.toThrow("cancelled");
		await expect(tool.execute("call2", { action: "inspect" })).rejects.toThrow("disabled");
		expect(mocks.launch).not.toHaveBeenCalled();
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
