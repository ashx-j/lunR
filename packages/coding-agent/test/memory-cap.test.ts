import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MEMORY_CAP_BRIDGE_SYMBOL,
	MEMORY_CHAR_CAP_DEFAULT,
	MEMORY_CHAR_CAP_MAX,
	MEMORY_CHAR_CAP_MIN,
	type MemoryCapBridge,
	registerMemoryCapBridge,
} from "../src/core/memory-cap.ts";
import {
	getSearchCuratorSetting,
	SEARCH_CURATOR_BRIDGE_SYMBOL,
	type SearchCuratorBridge,
	setSearchCuratorSetting,
} from "../src/core/search-curator.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("memoryCharCap setting", () => {
	const testDir = join(process.cwd(), "test-memory-cap-tmp");
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
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("defaults to 5000 when unset", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getMemoryCharCap()).toBe(MEMORY_CHAR_CAP_DEFAULT);
	});

	it("persists across instances (round-trip through settings.json)", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setMemoryCharCap(12000);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getMemoryCharCap()).toBe(12000);
	});

	it("clamps to 1..30000", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setMemoryCharCap(0);
		expect(manager.getMemoryCharCap()).toBe(MEMORY_CHAR_CAP_MIN);
		manager.setMemoryCharCap(999999);
		expect(manager.getMemoryCharCap()).toBe(MEMORY_CHAR_CAP_MAX);
		manager.setMemoryCharCap(2500.9);
		expect(manager.getMemoryCharCap()).toBe(2500);
	});
});

describe("memory-cap bridge", () => {
	const testDir = join(process.cwd(), "test-memory-cap-bridge-tmp");
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
		delete (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL];
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("exposes a bridge on globalThis that reads/writes lunR settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		registerMemoryCapBridge(manager);

		const bridge = (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL] as MemoryCapBridge;
		expect(bridge).toBeDefined();
		expect(bridge.getCharCap()).toBe(MEMORY_CHAR_CAP_DEFAULT);

		bridge.setCharCap(8000);
		expect(bridge.getCharCap()).toBe(8000);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getMemoryCharCap()).toBe(8000);
	});

	it("re-pointing the bridge swaps the settings source", async () => {
		const first = SettingsManager.create(projectDir, agentDir);
		registerMemoryCapBridge(first);
		const bridge = (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL] as MemoryCapBridge;
		bridge.setCharCap(7000);
		await first.flush();

		const second = SettingsManager.create(projectDir, agentDir);
		registerMemoryCapBridge(second);
		expect(bridge.getCharCap()).toBe(7000);
	});
});

describe("search-curator bridge consumer", () => {
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[SEARCH_CURATOR_BRIDGE_SYMBOL];
	});

	function registerFakeBridge(initialWorkflow: string): { written: string[] } {
		const state = { workflow: initialWorkflow, written: [] as string[] };
		const bridge: SearchCuratorBridge = {
			getWorkflow: () => state.workflow,
			setWorkflow: (workflow) => {
				state.written.push(workflow);
				state.workflow = workflow;
			},
		};
		(globalThis as Record<symbol, unknown>)[SEARCH_CURATOR_BRIDGE_SYMBOL] = bridge;
		return state;
	}

	it("returns undefined when the bridge is absent", () => {
		expect(getSearchCuratorSetting()).toBeUndefined();
		expect(setSearchCuratorSetting("on")).toBe(false);
	});

	it("maps workflows to settings values", () => {
		registerFakeBridge("none");
		expect(getSearchCuratorSetting()).toBe("off");
		registerFakeBridge("summary-review");
		expect(getSearchCuratorSetting()).toBe("on");
		registerFakeBridge("auto-summary");
		expect(getSearchCuratorSetting()).toBe("auto-summary");
	});

	it("writes settings values through the bridge as workflows", () => {
		const state = registerFakeBridge("none");
		expect(setSearchCuratorSetting("on")).toBe(true);
		expect(state.written).toEqual(["summary-review"]);
		expect(setSearchCuratorSetting("off")).toBe(true);
		expect(state.written).toEqual(["summary-review", "none"]);
		expect(setSearchCuratorSetting("auto-summary")).toBe(true);
		expect(state.written).toEqual(["summary-review", "none", "auto-summary"]);
	});
});
