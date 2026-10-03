import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ compiled: false, spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/config.ts", () => ({
	get isBunBinary() {
		return mocks.compiled;
	},
}));

import { installBrowser } from "../src/core/browser/setup.ts";

describe("browser installer dispatch", () => {
	afterEach(() => {
		mocks.compiled = false;
		mocks.spawn.mockReset();
		vi.restoreAllMocks();
	});

	it("refuses explicit compiled installation without launching the product executable", async () => {
		mocks.compiled = true;
		await expect(installBrowser()).rejects.toThrow(/same lunR version through npm.*PLAYWRIGHT_BROWSERS_PATH/);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("warns and lets implicit compiled setup continue without claiming Chromium installation", async () => {
		mocks.compiled = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(installBrowser(false)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/installation is unavailable.*same lunR version through npm.*PLAYWRIGHT_BROWSERS_PATH/),
		);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it.each([true, false])("runs the script with the Node interpreter, explicit=%s", async (explicit) => {
		mocks.spawn.mockImplementation(() => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("exit", 0));
			return child;
		});
		await installBrowser(explicit);
		expect(mocks.spawn).toHaveBeenCalledWith(
			process.execPath,
			[expect.stringMatching(/scripts[/\\]install-browser\.mjs$/), ...(explicit ? ["--explicit"] : [])],
			{ stdio: "inherit", windowsHide: true },
		);
	});

	it("reports installer failure", async () => {
		mocks.spawn.mockImplementation(() => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("exit", 42));
			return child;
		});
		await expect(installBrowser()).rejects.toThrow("Chromium setup failed (42)");
	});
});
