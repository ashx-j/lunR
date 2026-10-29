import { describe, expect, it } from "vitest";
import { isProductUninstallArgv } from "../src/core/install-features.ts";

describe("isProductUninstallArgv", () => {
	it("claims empty / product-only flags", () => {
		expect(isProductUninstallArgv([])).toBe(true);
		expect(isProductUninstallArgv(["--purge"])).toBe(true);
		expect(isProductUninstallArgv(["--yes", "--purge"])).toBe(true);
		expect(isProductUninstallArgv(["-y"])).toBe(true);
	});

	it("does not claim package-manager argv", () => {
		expect(isProductUninstallArgv(["npm:@x"])).toBe(false);
		expect(isProductUninstallArgv(["-l"])).toBe(false);
		expect(isProductUninstallArgv(["--help"])).toBe(false);
		expect(isProductUninstallArgv(["--local"])).toBe(false);
		expect(isProductUninstallArgv(["--approve"])).toBe(false);
	});
});
