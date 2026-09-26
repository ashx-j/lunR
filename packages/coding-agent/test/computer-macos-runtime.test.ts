import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacRuntime } from "../src/core/computer-use/macos-runtime.ts";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	exec: vi.fn(),
	close: vi.fn(),
	remove: vi.fn(),
	requests: [] as Array<{ method: string; args?: Record<string, unknown> }>,
}));
vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
	execFile: (...args: unknown[]) => {
		mocks.exec(...args.slice(0, -1));
		const callback = args.at(-1);
		if (typeof callback === "function") callback(null, "", "");
	},
}));
vi.mock("node:fs/promises", () => ({
	mkdtemp: async () => "/private/lunr-fixture",
	realpath: async () => "/private/tmp",
	open: async () => ({ close: mocks.close }),
	rm: mocks.remove,
}));
vi.mock("node:net", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		connect: () => {
			class Socket extends EventEmitter {
				setTimeout() {
					return this;
				}
				write(line: string) {
					const request = JSON.parse(line);
					mocks.requests.push(request);
					this.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({ ok: true, result: request.method === "metadata" ? { driver_version: "0.28.1", embedded: true, pid: 4242 } : { shutdown: true } })}\n`,
						),
					);
				}
				destroy() {
					return this;
				}
			}
			const socket = new Socket();
			queueMicrotask(() => socket.emit("connect"));
			return socket;
		},
	};
});
afterEach(() => {
	vi.resetAllMocks();
	mocks.requests.length = 0;
});

describe("private macOS app lifecycle", () => {
	it("waits for private metadata and closes only its own PID-bound daemon", async () => {
		const launcher = new EventEmitter();
		mocks.spawn.mockReturnValue(launcher);
		mocks.close.mockImplementation(async () => {
			launcher.emit("exit", 0);
		});
		const runtime = new MacRuntime();
		expect(await runtime.start("/owned/CuaDriver.app", new AbortController().signal)).toBe(
			join("/private/lunr-fixture", "driver.sock"),
		);
		expect(runtime.processId).toBe(4242);
		await runtime.close();
		await runtime.close();
		expect(mocks.requests).toEqual([
			{ method: "metadata" },
			{ method: "shutdown_if_pid", args: { expected_pid: 4242 } },
		]);
		expect(mocks.close).toHaveBeenCalledTimes(1);
		expect(mocks.remove).toHaveBeenCalledWith("/private/lunr-fixture", { recursive: true, force: true });
		expect(mocks.spawn).toHaveBeenCalledWith(
			"/usr/bin/open",
			expect.arrayContaining(["/owned/CuaDriver.app", "--parent-liveness-stdio"]),
			expect.any(Object),
		);
	});
	it("cleans a partial launch without selecting or terminating another app", async () => {
		const controller = new AbortController();
		controller.abort();
		const runtime = new MacRuntime();
		await expect(runtime.start("/owned/CuaDriver.app", controller.signal)).rejects.toThrow();
		await runtime.close();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.remove).toHaveBeenCalled();
	});
});
