import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyBehaviorPreset,
	BEHAVIOR_HEADER,
	BEHAVIOR_PRESET_BRIDGE_SYMBOL,
	type BehaviorPresetBridge,
	CONCISE_BEHAVIOR_PRESET,
	detectBehaviorPreset,
	HUMANIZER_BEHAVIOR_PRESET,
	isBuiltinBehaviorPreset,
	normalizeBehaviorBody,
	readBehaviorFile,
	reconcileBehaviorPreset,
	registerBehaviorPresetBridge,
	wrapBehaviorFile,
	writeBehaviorFile,
} from "../src/core/behavior-preset.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("behavior presets", () => {
	const testDir = join(process.cwd(), "test-behavior-preset-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[BEHAVIOR_PRESET_BRIDGE_SYMBOL];
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("fingerprints humanizer, concise, empty default, and anything else as custom", () => {
		expect(detectBehaviorPreset("")).toBe("default");
		expect(detectBehaviorPreset(BEHAVIOR_HEADER)).toBe("default");
		expect(detectBehaviorPreset(wrapBehaviorFile(HUMANIZER_BEHAVIOR_PRESET))).toBe("humanizer");
		expect(detectBehaviorPreset(wrapBehaviorFile(CONCISE_BEHAVIOR_PRESET))).toBe("concise");
		expect(detectBehaviorPreset(wrapBehaviorFile("Always use tabs."))).toBe("custom");
	});

	it("ignores the header comment and CRLF when fingerprinting", () => {
		const crlf = wrapBehaviorFile(HUMANIZER_BEHAVIOR_PRESET).replace(/\n/g, "\r\n");
		expect(detectBehaviorPreset(crlf)).toBe("humanizer");
		expect(normalizeBehaviorBody(`<!-- ignore me -->\n${HUMANIZER_BEHAVIOR_PRESET}`)).toBe(
			normalizeBehaviorBody(HUMANIZER_BEHAVIOR_PRESET),
		);
	});

	it("defaults the setting to default and persists a round-trip", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getBehaviorPreset()).toBe("default");
		manager.setBehaviorPreset("humanizer");
		await manager.flush();
		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getBehaviorPreset()).toBe("humanizer");
	});

	it("treats unknown stored values as default", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ behaviorPreset: "nope" }), "utf-8");
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getBehaviorPreset()).toBe("default");
	});

	it("writes the humanizer template when applying a built-in", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const result = applyBehaviorPreset(manager, "humanizer", agentDir);
		expect(result).toEqual({ ok: true, preset: "humanizer" });
		expect(manager.getBehaviorPreset()).toBe("humanizer");
		expect(detectBehaviorPreset(readBehaviorFile(agentDir))).toBe("humanizer");
		expect(readFileSync(join(agentDir, "behavior.md"), "utf-8").startsWith(BEHAVIOR_HEADER)).toBe(true);
	});

	it("custom apply does not touch the file", () => {
		writeBehaviorFile("Keep existing custom rules.", agentDir);
		const manager = SettingsManager.create(projectDir, agentDir);
		const result = applyBehaviorPreset(manager, "custom", agentDir);
		expect(result).toEqual({ ok: true, preset: "custom" });
		expect(normalizeBehaviorBody(readBehaviorFile(agentDir))).toBe("Keep existing custom rules.");
	});

	it("refuses to overwrite a custom file unless overwrite is set", () => {
		writeBehaviorFile("Do not clobber me.", agentDir);
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(applyBehaviorPreset(manager, "concise", agentDir)).toEqual({ ok: false, reason: "needs-overwrite" });
		expect(normalizeBehaviorBody(readBehaviorFile(agentDir))).toBe("Do not clobber me.");
		expect(applyBehaviorPreset(manager, "concise", agentDir, { overwrite: true })).toEqual({
			ok: true,
			preset: "concise",
		});
		expect(detectBehaviorPreset(readBehaviorFile(agentDir))).toBe("concise");
	});

	it("reconcile flips a drifted built-in file to custom", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setBehaviorPreset("humanizer");
		writeBehaviorFile("A hand edit while humanizer was selected.", agentDir);
		expect(reconcileBehaviorPreset(manager, agentDir)).toBe("custom");
		expect(manager.getBehaviorPreset()).toBe("custom");
	});

	it("reconcile restores a missing built-in file", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setBehaviorPreset("concise");
		expect(reconcileBehaviorPreset(manager, agentDir)).toBe("concise");
		expect(detectBehaviorPreset(readBehaviorFile(agentDir))).toBe("concise");
	});

	it("reconcile does not overwrite a stored custom file", () => {
		writeBehaviorFile("User owned.", agentDir);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setBehaviorPreset("custom");
		expect(reconcileBehaviorPreset(manager, agentDir)).toBe("custom");
		expect(normalizeBehaviorBody(readBehaviorFile(agentDir))).toBe("User owned.");
	});

	it("bridge reports cap exemption only for built-ins and flips on file drift", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerBehaviorPresetBridge(manager);
		const bridge = (globalThis as Record<symbol, unknown>)[BEHAVIOR_PRESET_BRIDGE_SYMBOL] as BehaviorPresetBridge;
		expect(bridge.isCapExempt()).toBe(true);
		expect(isBuiltinBehaviorPreset("humanizer")).toBe(true);
		expect(isBuiltinBehaviorPreset("custom")).toBe(false);

		manager.setBehaviorPreset("humanizer");
		expect(bridge.syncFromFile(wrapBehaviorFile("hand-edited"))).toBe("custom");
		expect(manager.getBehaviorPreset()).toBe("custom");
		expect(bridge.isCapExempt()).toBe(false);
	});
});
