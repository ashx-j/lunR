import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MEMORY_CHAR_CAP_DEFAULT,
	MEMORY_CHAR_CAP_MAX,
	MEMORY_CHAR_CAP_MIN,
	SettingsManager,
} from "../src/core/settings-manager.ts";
import { createMemoryTools } from "../src/features/memory.ts";

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

describe("memory tools cap enforcement", () => {
	const testDir = join(process.cwd(), "test-memory-tools-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	let savedAgentDirEnv: string | undefined;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		// Pre-create an empty memory file so the one-time legacy migration is a no-op.
		writeFileSync(join(agentDir, "memory.md"), "");
		savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (savedAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function findTool(tools: ReturnType<typeof createMemoryTools>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool not found: ${name}`);
		return tool;
	}

	it("memory_add refuses when the file would exceed the settings cap", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setMemoryCharCap(40);
		const tools = createMemoryTools(manager);
		const add = findTool(tools, "memory_add");

		const first = await add.execute("t1", { content: "short" }, undefined, undefined, undefined as never);
		expect(first.content[0].text).toContain("Added memory");

		const second = await add.execute(
			"t2",
			{ content: "this memory line is far too long to fit" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(second.content[0].text).toContain("Memory full");
		expect(second.content[0].text).toContain("/40 chars");
	});

	it("memory_load reports the settings cap", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setMemoryCharCap(12345);
		const tools = createMemoryTools(manager);
		const load = findTool(tools, "memory_load");

		const result = await load.execute("t1", {}, undefined, undefined, undefined as never);
		expect(result.content[0].text).toBe("Memory is empty (0/12345 chars).");
	});
});

describe("search-curator setting (web-access feature)", () => {
	const testDir = join(process.cwd(), "test-search-curator-tmp");
	const agentDir = join(testDir, "agent");
	let savedAgentDirEnv: string | undefined;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (savedAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	// The web-search.json path is resolved when the feature module is first
	// loaded, so import it lazily after PI_CODING_AGENT_DIR points at the tmp dir.
	async function loadFeature() {
		return await import("../src/features/web-access/index.ts");
	}

	it("maps workflows to settings values", async () => {
		writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ workflow: "none" }));
		const { getSearchCuratorSetting } = await loadFeature();
		expect(getSearchCuratorSetting()).toBe("off");
		writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ workflow: "summary-review" }));
		expect(getSearchCuratorSetting()).toBe("on");
		writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ workflow: "auto-summary" }));
		expect(getSearchCuratorSetting()).toBe("auto-summary");
	});

	it("writes settings values as workflows to web-search.json", async () => {
		const { getSearchCuratorSetting, setSearchCuratorSetting } = await loadFeature();
		// No config file: the curator workflow (summary-review) is the default.
		expect(getSearchCuratorSetting()).toBe("on");
		setSearchCuratorSetting("off");
		expect(JSON.parse(readFileSync(join(agentDir, "web-search.json"), "utf-8")).workflow).toBe("none");
		setSearchCuratorSetting("auto-summary");
		expect(JSON.parse(readFileSync(join(agentDir, "web-search.json"), "utf-8")).workflow).toBe("auto-summary");
		setSearchCuratorSetting("on");
		expect(JSON.parse(readFileSync(join(agentDir, "web-search.json"), "utf-8")).workflow).toBe("summary-review");
	});
});
