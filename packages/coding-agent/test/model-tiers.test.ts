import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentToolDescription } from "../src/builtin-extensions/pi-subagents/src/extension/tool-description.ts";
import { resolveTierModelOverride } from "../src/builtin-extensions/pi-subagents/src/runs/shared/model-fallback.ts";
import {
	getModelTiersBridge,
	getTierModel,
	isTierModeEnabled,
	MODEL_TIERS_BRIDGE_SYMBOL,
	type ModelTiersBridge,
	registerModelTierBridge,
} from "../src/core/model-tiers.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const TIER_GUIDANCE_MARKER = "MODEL TIERS:";

function clearModelTiersBridge(): void {
	const bridge = getModelTiersBridge();
	if (typeof bridge?.registerToolDescriptionRefresher === "function") {
		bridge.registerToolDescriptionRefresher(undefined);
	}
	delete (globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL];
}

describe("model-tiers settings", () => {
	const testDir = join(process.cwd(), "test-model-tiers-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		clearModelTiersBridge();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("defaults to disabled with no tier models", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getModelTiersEnabled()).toBe(false);
		expect(manager.getTierModel("light")).toBeUndefined();
		expect(manager.getTierModel("standard")).toBeUndefined();
		expect(manager.getTierModel("heavy")).toBeUndefined();
	});

	it("persists enabled flag and per-tier models", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelTiersEnabled(true);
		manager.setTierModel("light", "xai/grok-4");
		manager.setTierModel("standard", "anthropic/claude-sonnet-4-20250514");
		manager.setTierModel("heavy", "anthropic/claude-opus-4-20250514");
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getModelTiersEnabled()).toBe(true);
		expect(reloaded.getTierModel("light")).toBe("xai/grok-4");
		expect(reloaded.getTierModel("standard")).toBe("anthropic/claude-sonnet-4-20250514");
		expect(reloaded.getTierModel("heavy")).toBe("anthropic/claude-opus-4-20250514");
	});
});

describe("model-tiers bridge", () => {
	const testDir = join(process.cwd(), "test-model-tiers-bridge-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		clearModelTiersBridge();
	});

	afterEach(() => {
		clearModelTiersBridge();
		vi.restoreAllMocks();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("exposes enabled state and tier models from settings", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelTiersEnabled(true);
		manager.setTierModel("light", "xai/grok-4");
		registerModelTierBridge(manager);

		const bridge = (globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] as ModelTiersBridge;
		expect(bridge.isTierModeEnabled()).toBe(true);
		expect(bridge.getTierModel("light")).toBe("xai/grok-4");
		expect(bridge.getTierModel("standard")).toBeUndefined();
		expect(bridge.getTierModel("unknown")).toBeUndefined();
		expect(isTierModeEnabled()).toBe(true);
		expect(getTierModel("light")).toBe("xai/grok-4");
	});

	it("refreshToolDescription is a no-op when no refresher is registered", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerModelTierBridge(manager);
		expect(() => getModelTiersBridge()?.refreshToolDescription()).not.toThrow();
	});

	it("invokes the registered refresher", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerModelTierBridge(manager);
		const refresher = vi.fn();
		getModelTiersBridge()?.registerToolDescriptionRefresher(refresher);
		getModelTiersBridge()?.refreshToolDescription();
		expect(refresher).toHaveBeenCalledTimes(1);
	});

	it("swallows refresher throws so a settings toggle cannot kill the process", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerModelTierBridge(manager);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getModelTiersBridge()?.registerToolDescriptionRefresher(() => {
			throw new TypeError("Cannot read properties of undefined (reading 'refreshTools')");
		});
		expect(() => getModelTiersBridge()?.refreshToolDescription()).not.toThrow();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("refreshToolDescription failed"));
	});

	it("re-register replaces the previous refresher", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerModelTierBridge(manager);
		const first = vi.fn();
		const second = vi.fn();
		getModelTiersBridge()?.registerToolDescriptionRefresher(first);
		getModelTiersBridge()?.registerToolDescriptionRefresher(second);
		getModelTiersBridge()?.refreshToolDescription();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});

describe("subagent tool description tier guidance", () => {
	afterEach(() => {
		clearModelTiersBridge();
	});

	it("omits MODEL TIERS guidance when the bridge is absent", () => {
		expect(buildSubagentToolDescription()).not.toContain(TIER_GUIDANCE_MARKER);
	});

	it("omits MODEL TIERS guidance when tier mode is disabled", () => {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => false,
		};
		expect(buildSubagentToolDescription()).not.toContain(TIER_GUIDANCE_MARKER);
	});

	it("appends MODEL TIERS guidance when tier mode is enabled", () => {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => true,
		};
		expect(buildSubagentToolDescription()).toContain(TIER_GUIDANCE_MARKER);
	});
});

describe("resolveTierModelOverride", () => {
	afterEach(() => {
		clearModelTiersBridge();
	});

	function installBridge(opts: { enabled: boolean; models?: Record<string, string | undefined> }): void {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => opts.enabled,
			getTierModel: (tier: string) => opts.models?.[tier],
		};
	}

	it("returns undefined when the bridge is absent", () => {
		expect(resolveTierModelOverride("light")).toBeUndefined();
	});

	it("returns undefined when tier mode is disabled", () => {
		installBridge({ enabled: false, models: { light: "xai/grok-4" } });
		expect(resolveTierModelOverride("light")).toBeUndefined();
	});

	it("returns undefined for unknown or unset tiers", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(resolveTierModelOverride("nope")).toBeUndefined();
		expect(resolveTierModelOverride("standard")).toBeUndefined();
		expect(resolveTierModelOverride("")).toBeUndefined();
		expect(resolveTierModelOverride(undefined)).toBeUndefined();
	});

	it("returns the configured provider/model when enabled", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4", heavy: "  anthropic/claude-opus-4-20250514  " } });
		expect(resolveTierModelOverride("light")).toBe("xai/grok-4");
		expect(resolveTierModelOverride("heavy")).toBe("anthropic/claude-opus-4-20250514");
	});
});
