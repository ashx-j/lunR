import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";

const imported = vi.hoisted(() => ({ main: false }));

vi.mock("../src/main.ts", () => {
	imported.main = true;
	return { main: vi.fn(async () => {}) };
});

class ProcessExit extends Error {}

const originalArgv = process.argv;

afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
});

describe("cli-runtime --version", () => {
	it("prints the version without importing main.ts", async () => {
		process.argv = [process.execPath, "lunr", "--version"];
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ProcessExit();
		});

		await expect(import("../src/cli-runtime.ts")).rejects.toBeInstanceOf(ProcessExit);

		expect(log).toHaveBeenCalledWith(VERSION);
		expect(imported.main).toBe(false);
	});
});
