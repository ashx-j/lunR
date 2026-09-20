import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readBrowserSettings } from "../src/core/browser/settings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "browser-settings-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("defaults new and existing unconfigured users to Browser on with public network only", () => {
	expect(SettingsManager.create(dir, dir).getBrowserEnabled()).toBe(true);
	expect(readBrowserSettings()).toEqual({ enabled: true, allowPrivate: false });
});
it("preserves legacy explicit disable until a user changes the new setting", async () => {
	writeFileSync(
		join(dir, "install-features.json"),
		JSON.stringify({ schemaVersion: 1, features: { browser: { enabled: false, options: {} } } }),
	);
	const settings = SettingsManager.create(dir, dir);
	expect(settings.getBrowserEnabled()).toBe(false);
	expect(readBrowserSettings().enabled).toBe(false);
	settings.setBrowserEnabled(true);
	await settings.flush();
	expect(SettingsManager.create(dir, dir).getBrowserEnabled()).toBe(true);
	expect(readBrowserSettings().enabled).toBe(true);
	settings.setBrowserEnabled(false);
	await settings.flush();
	expect(SettingsManager.create(dir, dir).getBrowserEnabled()).toBe(false);
});
it("keeps explicit network configuration independent of browser enablement", () => {
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ browserEnabled: true, browserAllowPrivateNetwork: true }),
	);
	expect(readBrowserSettings()).toEqual({ enabled: true, allowPrivate: true });
});
