import { afterEach, expect, it, vi } from "vitest";
import { restoreStdout, takeOverStdout } from "../src/core/output-guard.ts";

afterEach(() => {
	restoreStdout();
	vi.restoreAllMocks();
});

// The CLI runs from a bundle while built-in extensions import core/output-guard.ts unbundled.
it("lets a second copy of the module write raw stdout after the first took it over", async () => {
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	});
	const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	takeOverStdout();
	// A fresh module instance stands in for the unbundled copy an extension imports.
	vi.resetModules();
	const copy = await import("../src/core/output-guard.ts");
	copy.writeRawStdout("raw line\n");
	await copy.flushRawStdout();
	expect(stdoutWrite.mock.calls.some(([chunk]) => String(chunk) === "raw line\n")).toBe(true);
	expect(stderrWrite.mock.calls.some(([chunk]) => String(chunk) === "raw line\n")).toBe(false);
});
