import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaAdapter } from "../src/core/computer-use/adapter.ts";

vi.mock("../src/core/computer-use/windows-desktop.ts", () => ({ assertInteractiveDesktop: async () => undefined }));

const mocks = vi.hoisted(() => ({
	install: vi.fn(),
	connect: vi.fn(),
	closeClient: vi.fn(),
	closeTransport: vi.fn(),
	call: vi.fn(),
	transport: vi.fn(),
	pid: undefined as number | undefined,
}));
vi.mock("../src/core/computer-use/runtime.ts", () => ({
	CUA_VERSION: "0.28.1",
	installRuntime: mocks.install,
	runtimeEnvironment: () => ({ CUA_DRIVER_PERMISSION_MODE: "standard" }),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = mocks.connect;
		close = mocks.closeClient;
		callTool = mocks.call;
		getServerVersion() {
			return { version: "0.28.1" };
		}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class {
		constructor(options: unknown) {
			mocks.transport(options);
		}
		close = mocks.closeTransport;
		get pid() {
			return mocks.pid;
		}
	},
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	mocks.pid = undefined;
});

describe("computer adapter lifecycle", () => {
	it("refuses all driver operations when runtime ownership cannot be recorded", async () => {
		mocks.install.mockResolvedValue({ command: "fixture.exe" });
		mocks.pid = 4242;
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("process exited"), { code: "ESRCH" });
		});
		const record = vi.fn(async () => {
			throw new Error("ownership record failed");
		});
		const adapter = new CuaAdapter();
		adapter.setProcessObserver(record);
		await expect(adapter.call("click", {})).rejects.toThrow("ownership record failed");
		expect(record).toHaveBeenCalledWith(4242);
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.closeTransport).toHaveBeenCalled();
	});
	it("does not create a transport after close during installation", async () => {
		let finish: ((value: { command: string }) => void) | undefined;
		mocks.install.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const adapter = new CuaAdapter();
		const call = adapter.call("list_apps", {});
		const rejected = expect(call).rejects.toThrow();
		await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
		const closed = adapter.close();
		finish?.({ command: "fixture.exe" });
		await closed;
		await rejected;
		expect(mocks.transport).not.toHaveBeenCalled();
	});
	it("closes partial MCP initialization on combined cancellation", async () => {
		mocks.install.mockResolvedValue({ command: "fixture.exe" });
		mocks.connect.mockImplementation(
			(_transport, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("connect aborted")), { once: true });
				}),
		);
		const controller = new AbortController();
		const adapter = new CuaAdapter();
		const call = adapter.call("list_apps", {}, controller.signal);
		const rejected = expect(call).rejects.toThrow("connect aborted");
		await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalled());
		controller.abort();
		await rejected;
		expect(mocks.closeClient).toHaveBeenCalledTimes(1);
		expect(mocks.closeTransport).toHaveBeenCalledTimes(1);
		expect(mocks.call).not.toHaveBeenCalled();
	});
	it("shares initialization and sanitizes runtime state into an isolated profile", async () => {
		mocks.install.mockResolvedValue({ command: "fixture.exe" });
		mocks.call.mockResolvedValue({ content: [] });
		const adapter = new CuaAdapter();
		await Promise.all([adapter.call("list_apps", {}), adapter.call("list_apps", {})]);
		expect(mocks.install).toHaveBeenCalledTimes(1);
		expect(mocks.transport).toHaveBeenCalledWith(
			expect.objectContaining({
				args: ["mcp", "--direct", "--embedded", "--no-overlay"],
				env: expect.objectContaining({
					CUA_DRIVER_PERMISSION_MODE: "standard",
					HOME: expect.stringContaining("lunr-cua-client-"),
				}),
			}),
		);
		await adapter.close();
		await expect(adapter.call("list_apps", {})).rejects.toThrow();
	});
});
