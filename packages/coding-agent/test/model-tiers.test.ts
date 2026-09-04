import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentToolDescription } from "../src/builtin-extensions/pi-subagents/src/extension/tool-description.ts";
import {
	captureModelSelection,
	resolveRequiredTierModel,
	resolveTierModelOverride,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/model-fallback.ts";
import {
	getModelTiersBridge,
	getTierModel,
	isTierModeEnabled,
	MODEL_TIERS_BRIDGE_SYMBOL,
	type ModelTiersBridge,
	registerModelTierBridge,
} from "../src/core/model-tiers.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const TIER_GUIDANCE_MARKER = "Every executable child requires tier";

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

	it("persists per-tier thinking and clears inherit", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelTiersEnabled(true);
		manager.setTierThinking("light", "off");
		manager.setTierThinking("heavy", "high");
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getTierThinking("light")).toBe("off");
		expect(reloaded.getTierThinking("standard")).toBeUndefined();
		expect(reloaded.getTierThinking("heavy")).toBe("high");

		reloaded.setTierThinking("light", undefined);
		await reloaded.flush();
		expect(SettingsManager.create(projectDir, agentDir).getTierThinking("light")).toBeUndefined();
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

	it("requires tiers even when the bridge is absent", () => {
		expect(buildSubagentToolDescription()).toContain(TIER_GUIDANCE_MARKER);
	});

	it("requires tiers when tier mode is disabled", () => {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => false,
		};
		expect(buildSubagentToolDescription()).toContain(TIER_GUIDANCE_MARKER);
	});

	it("requires tiers when tier mode is enabled", () => {
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

	function installBridge(opts: {
		enabled: boolean;
		models?: Record<string, string | undefined>;
		thinking?: Record<string, string | undefined>;
		parentThinking?: string;
	}): void {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => opts.enabled,
			getTierModel: (tier: string) => opts.models?.[tier],
			getTierThinking: (tier: string) => opts.thinking?.[tier],
			getParentThinking: () => opts.parentThinking,
		};
	}

	it("fails closed when the bridge is absent", () => {
		expect(() => resolveTierModelOverride("light")).toThrow(/settings are unavailable/i);
	});

	it("fails closed when tier mode is disabled", () => {
		installBridge({ enabled: false, models: { light: "xai/grok-4" } });
		expect(() => resolveTierModelOverride("light")).toThrow(/tiers are disabled/i);
	});

	it("fails closed for unknown or unset tiers", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(() => resolveTierModelOverride("nope")).toThrow(/requires tier/i);
		expect(() => resolveTierModelOverride("standard")).toThrow(/no configured model/i);
		expect(() => resolveTierModelOverride("")).toThrow(/requires tier/i);
		expect(() => resolveTierModelOverride(undefined)).toThrow(/requires tier/i);
	});

	it("returns the configured provider/model when enabled", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4", heavy: "  anthropic/claude-opus-4-20250514  " } });
		expect(resolveTierModelOverride("light")).toBe("xai/grok-4");
		expect(resolveTierModelOverride("heavy")).toBe("anthropic/claude-opus-4-20250514");
	});

	it("appends parent thinking when the tier thinking is unset", () => {
		installBridge({
			enabled: true,
			models: { light: "xai/grok-4" },
			parentThinking: "high",
		});
		expect(resolveTierModelOverride("light")).toBe("xai/grok-4:high");
	});

	it("uses the tier thinking over the parent session level", () => {
		installBridge({
			enabled: true,
			models: { light: "xai/grok-4" },
			thinking: { light: "off" },
			parentThinking: "high",
		});
		expect(resolveTierModelOverride("light")).toBe("xai/grok-4:off");
	});

	it("does not fall back when tiers are disabled", () => {
		installBridge({
			enabled: false,
			models: { light: "xai/grok-4" },
			thinking: { light: "high" },
			parentThinking: "high",
		});
		expect(() => resolveTierModelOverride("light")).toThrow(/tiers are disabled/i);
	});

	it("fails when the configured model is unavailable or no credentials expose models", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(() => resolveRequiredTierModel("light", [])).toThrow(/no authenticated models/i);
		expect(() =>
			resolveRequiredTierModel("light", [{ provider: "anthropic", id: "claude", fullId: "anthropic/claude" }]),
		).toThrow(/unavailable or unauthenticated/i);
	});

	it("returns the exact available model with its thinking suffix", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" }, thinking: { light: "high" } });
		expect(resolveRequiredTierModel("light", [{ provider: "xai", id: "grok-4", fullId: "xai/grok-4" }])).toBe(
			"xai/grok-4:high",
		);
	});
});

describe("captureModelSelection", () => {
	afterEach(() => {
		clearModelTiersBridge();
	});

	function installBridge(opts: { enabled: boolean; models?: Record<string, string | undefined> }): void {
		(globalThis as Record<symbol, unknown>)[MODEL_TIERS_BRIDGE_SYMBOL] = {
			isTierModeEnabled: () => opts.enabled,
			getTierModel: (tier: string) => opts.models?.[tier],
		};
	}

	it("ignores retired explicit model input and captures the required tier", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(captureModelSelection({ model: "xai/grok-4.5", tier: "light" })).toEqual({ kind: "tier", tier: "light" });
	});

	it("captures a resolving tier", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(captureModelSelection({ tier: "light" })).toEqual({ kind: "tier", tier: "light" });
	});

	it("captures the requested tier independently of runtime configuration", () => {
		installBridge({ enabled: false, models: { light: "xai/grok-4" } });
		expect(captureModelSelection({ tier: "light" })).toEqual({ kind: "tier", tier: "light" });
	});

	it("captures an unconfigured tier so later resolution can fail closed", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(captureModelSelection({ tier: "standard" })).toEqual({ kind: "tier", tier: "standard" });
	});

	it("rejects when tier is omitted", () => {
		expect(() => captureModelSelection({})).toThrow(/requires tier/i);
	});

	it("does not expose the retired inherit sentinel", () => {
		installBridge({ enabled: true, models: { light: "xai/grok-4" } });
		expect(captureModelSelection({ model: "inherit", tier: "light" })).toEqual({ kind: "tier", tier: "light" });
	});
});
