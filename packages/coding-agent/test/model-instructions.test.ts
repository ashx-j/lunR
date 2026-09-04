import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureModelInstructionDirs,
	getGlobalInstructionsPath,
	getInstructionsRoot,
	getModelInstructionsPath,
	isUserInstructionsPath,
	loadSelectedUserInstructions,
	migrateLegacyGlobalInstructions,
	modelInstructionFolderName,
} from "../src/core/model-instructions.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("model-specific user instructions", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `lunr-model-instructions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("migrates the legacy global AGENTS.md without overwriting a current file", () => {
		const legacy = join(agentDir, "AGENTS.md");
		const current = getGlobalInstructionsPath(agentDir);
		writeFileSync(legacy, "legacy instructions");

		expect(migrateLegacyGlobalInstructions(agentDir)).toEqual({ status: "migrated" });
		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(current, "utf8")).toBe("legacy instructions");

		writeFileSync(legacy, "new legacy content");
		expect(migrateLegacyGlobalInstructions(agentDir)).toMatchObject({ status: "conflict" });
		expect(readFileSync(current, "utf8")).toBe("legacy instructions");
		expect(readFileSync(legacy, "utf8")).toBe("new legacy content");
	});

	it("uses a provider-independent safe final model-id segment and prevents collisions after sanitizing", () => {
		expect(modelInstructionFolderName("openai/gpt-5.6")).toBe(modelInstructionFolderName("azure/gpt-5.6"));
		expect(modelInstructionFolderName("openai/gpt-5.6:high")).toBe("gpt-5.6");
		expect(modelInstructionFolderName("../../CON")).not.toMatch(/^(con|\.\.?$)/i);
		expect(modelInstructionFolderName("provider/a:b")).not.toBe(modelInstructionFolderName("provider/a?b"));

		for (const id of ["../../AGENTS.md", "provider/a:b", "provider/a?b", "provider/.."] ) {
			const path = getModelInstructionsPath(agentDir, id);
			expect(relative(resolve(getInstructionsRoot(agentDir)), resolve(path))).not.toMatch(/^\.\.(?:[\\/]|$)/);
			expect(basename(path)).toBe("AGENTS.md");
			expect(isUserInstructionsPath(path, agentDir)).toBe(true);
		}
		expect(isUserInstructionsPath(join(agentDir, "agents-escape", "AGENTS.md"), agentDir)).toBe(false);
	});

	it("loads global instructions while disabled and applies both/model-only selection to the current model", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const globalPath = getGlobalInstructionsPath(agentDir);
		const firstModelPath = getModelInstructionsPath(agentDir, "openai/gpt-5.6");
		const secondModelPath = getModelInstructionsPath(agentDir, "anthropic/claude-sonnet-4-5");
		for (const path of [globalPath, firstModelPath, secondModelPath]) mkdirSync(dirname(path), { recursive: true });
		writeFileSync(globalPath, "global rule");
		writeFileSync(firstModelPath, "gpt rule");
		writeFileSync(secondModelPath, "claude rule");

		expect(loadSelectedUserInstructions({ agentDir, settingsManager: manager, model: { id: "openai/gpt-5.6" } }))
			.toEqual([{ path: globalPath, content: "global rule" }]);

		manager.setModelInstructionsEnabled(true);
		expect(loadSelectedUserInstructions({ agentDir, settingsManager: manager, model: { id: "openai/gpt-5.6" } }))
			.toEqual([{ path: globalPath, content: "global rule" }, { path: firstModelPath, content: "gpt rule" }]);
		expect(loadSelectedUserInstructions({ agentDir, settingsManager: manager, model: { id: "anthropic/claude-sonnet-4-5" } }))
			.toEqual([{ path: globalPath, content: "global rule" }, { path: secondModelPath, content: "claude rule" }]);

		manager.setModelInstructionsMode("model-only");
		expect(loadSelectedUserInstructions({ agentDir, settingsManager: manager, model: { id: "openai/gpt-5.6" } }))
			.toEqual([{ path: firstModelPath, content: "gpt rule" }]);
	});

	it("persists model-instruction mode and large-launch confirmation defaults", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getModelInstructions()).toEqual({ enabled: false, mode: "both" });
		expect(manager.getConfirmLargeSubagentLaunches()).toBe(true);
		manager.setModelInstructionsEnabled(true);
		manager.setModelInstructionsMode("model-only");
		manager.setConfirmLargeSubagentLaunches(false);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getModelInstructions()).toEqual({ enabled: true, mode: "model-only" });
		expect(reloaded.getConfirmLargeSubagentLaunches()).toBe(false);
	});

	it("backfills directories for the current, default, enabled, and tier models", () => {
		const diagnostics = ensureModelInstructionDirs(agentDir, {
			defaultModel: "openai/gpt-default",
			enabledModels: ["anthropic/claude-enabled", "openrouter/*"],
			modelTiers: { enabled: true, light: "xai/grok-light", standard: "google/gemini-standard", heavy: "openai/gpt-heavy" },
		}, { id: "current/current-model" });
		expect(diagnostics).toEqual([]);
		for (const id of ["gpt-default", "claude-enabled", "grok-light", "gemini-standard", "gpt-heavy", "current-model"]) {
			expect(existsSync(join(getInstructionsRoot(agentDir), id))).toBe(true);
		}
		expect(existsSync(join(getInstructionsRoot(agentDir), "*"))).toBe(false);
	});

	it("keeps project context independent and --no-context-files suppresses all instruction files", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		mkdirSync(dirname(getGlobalInstructionsPath(agentDir)), { recursive: true });
		writeFileSync(getGlobalInstructionsPath(agentDir), "global rule");
		writeFileSync(join(projectDir, "AGENTS.md"), "project rule");

		const normal = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager: manager });
		await normal.reload();
		expect(normal.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["global rule", "project rule"]);

		const disabled = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager: manager, noContextFiles: true });
		await disabled.reload();
		expect(disabled.contextFilesEnabled()).toBe(false);
		expect(disabled.getAgentsFiles().agentsFiles).toEqual([]);
	});
});
