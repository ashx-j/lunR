import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCustomizeBridge, registerCustomizeBridge } from "../src/core/customize.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("customize bridge runtime replacement", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reads settings from the replacement runtime manager", async () => {
		root = mkdtempSync(join(tmpdir(), "customize-bridge-replacement-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ footerTps: false }));

		const initialManager = SettingsManager.create(projectDir, agentDir);
		registerCustomizeBridge(initialManager);

		const replacementManager = SettingsManager.create(projectDir, agentDir);
		registerCustomizeBridge(replacementManager);
		replacementManager.setFooterTps(true);
		await replacementManager.flush();

		expect(JSON.parse(readFileSync(settingsPath, "utf8")).footerTps).toBe(true);
		expect(getCustomizeBridge()?.getFooterTps()).toBe(true);
	});
});
