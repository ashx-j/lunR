import { afterEach, describe, expect, it, vi } from "vitest";
import { assertInteractiveDesktop, WINDOWS_DESKTOP_PROBE } from "../src/core/computer-use/windows-desktop.ts";

const probe = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => {
		const stdout = probe(...args.slice(0, -1)) ?? "ready\r\n";
		const callback = args.at(-1);
		if (typeof callback === "function") callback(null, { stdout });
	},
}));
const platform = process.platform;
afterEach(() => {
	vi.resetAllMocks();
	Object.defineProperty(process, "platform", { value: platform });
});

describe("Windows desktop admission", () => {
	it("accepts only an affirmative metadata probe with a bounded hidden system helper", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		await assertInteractiveDesktop();
		expect(probe).toHaveBeenCalledWith(
			expect.stringContaining("System32"),
			["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DESKTOP_PROBE],
			expect.objectContaining({ timeout: 5000, windowsHide: true }),
		);
		probe.mockReturnValue("unavailable\r\n");
		await expect(assertInteractiveDesktop()).rejects.toThrow("active, unlocked");
	});
	it("does not run a Windows helper on macOS", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		await assertInteractiveDesktop();
		expect(probe).not.toHaveBeenCalled();
	});
});
