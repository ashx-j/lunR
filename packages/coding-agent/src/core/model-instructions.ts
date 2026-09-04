import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { Settings, SettingsManager } from "./settings-manager.ts";

export type ModelInstructionsMode = "both" | "model-only";

export interface ModelInstructionsMigrationResult {
	status: "absent" | "migrated" | "conflict" | "failed";
	diagnostic?: string;
}

export function getInstructionsRoot(agentDir: string): string {
	return join(resolve(agentDir), "agents");
}

export function getGlobalInstructionsPath(agentDir: string): string {
	return join(getInstructionsRoot(agentDir), "AGENTS.md");
}

export function modelInstructionFolderName(modelId: string): string {
	const finalSegment = modelId.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? "model";
	const withoutThinking = finalSegment.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
	let safe = withoutThinking.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
	if (!safe || safe === "." || safe === "..") safe = "model";
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
	if (safe.length > 100 || safe.toLowerCase() !== withoutThinking.toLowerCase()) {
		const digest = createHash("sha256").update(withoutThinking.toLowerCase()).digest("hex").slice(0, 8);
		safe = `${safe.slice(0, 90)}-${digest}`;
	}
	return safe.toLowerCase();
}

export function getModelInstructionsPath(agentDir: string, modelId: string): string {
	return join(getInstructionsRoot(agentDir), modelInstructionFolderName(modelId), "AGENTS.md");
}

export function isUserInstructionsPath(filePath: string, agentDir: string): boolean {
	const rel = relative(resolve(getInstructionsRoot(agentDir)), resolve(filePath));
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function migrateLegacyGlobalInstructions(agentDir: string): ModelInstructionsMigrationResult {
	const legacyPath = join(resolve(agentDir), "AGENTS.md");
	const destinationPath = getGlobalInstructionsPath(agentDir);
	if (!existsSync(legacyPath)) return { status: "absent" };
	if (existsSync(destinationPath)) {
		return {
			status: "conflict",
			diagnostic: `Both legacy '${legacyPath}' and current '${destinationPath}' exist. Kept both and will use the current file.`,
		};
	}
	try {
		mkdirSync(getInstructionsRoot(agentDir), { recursive: true });
		renameSync(legacyPath, destinationPath);
		return { status: "migrated" };
	} catch (error) {
		return {
			status: "failed",
			diagnostic: `Could not migrate '${legacyPath}' to '${destinationPath}': ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function concreteModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || /[*?{}]/.test(trimmed)) return undefined;
	return trimmed.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
}

export function ensureModelInstructionDirs(
	agentDir: string,
	settings: Pick<Settings, "defaultModel" | "enabledModels" | "modelTiers">,
	currentModel?: Pick<Model<any>, "id">,
): string[] {
	const modelIds = new Set<string>();
	const add = (value: unknown) => {
		const id = concreteModelId(value);
		if (id) modelIds.add(id);
	};
	add(currentModel?.id);
	add(settings.defaultModel);
	for (const value of settings.enabledModels ?? []) add(value);
	add(settings.modelTiers?.light);
	add(settings.modelTiers?.standard);
	add(settings.modelTiers?.heavy);

	const diagnostics: string[] = [];
	for (const id of modelIds) {
		try {
			mkdirSync(join(getInstructionsRoot(agentDir), modelInstructionFolderName(id)), { recursive: true });
		} catch (error) {
			diagnostics.push(
				`Could not prepare model-instruction folder for '${id}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return diagnostics;
}

function safeReadInstruction(path: string): { path: string; content: string } | undefined {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return undefined;
		return { path, content: readFileSync(path, "utf8") };
	} catch {
		return undefined;
	}
}

export function loadSelectedUserInstructions(options: {
	agentDir: string;
	settingsManager: SettingsManager;
	model?: Pick<Model<any>, "id">;
}): Array<{ path: string; content: string }> {
	ensureModelInstructionDirs(options.agentDir, options.settingsManager.getGlobalSettings(), options.model);
	const enabled = options.settingsManager.getModelInstructionsEnabled();
	const mode = options.settingsManager.getModelInstructionsMode();
	const files: Array<{ path: string; content: string }> = [];
	if (!enabled || mode === "both") {
		const globalFile = safeReadInstruction(getGlobalInstructionsPath(options.agentDir));
		if (globalFile) files.push(globalFile);
	}
	if (enabled && options.model) {
		const modelFile = safeReadInstruction(getModelInstructionsPath(options.agentDir, options.model.id));
		if (modelFile) files.push(modelFile);
	}
	return files;
}

export function instructionPathLabel(filePath: string, agentDir: string): string | undefined {
	const resolved = resolve(filePath);
	if (resolved.toLowerCase() === resolve(getGlobalInstructionsPath(agentDir)).toLowerCase()) {
		return "Global AGENTS.md";
	}
	if (!isUserInstructionsPath(resolved, agentDir)) return undefined;
	return `${basename(resolve(resolved, ".."))} AGENTS.md`;
}
