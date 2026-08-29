// @ts-nocheck
/**
 * Chain behavior, template resolution, and directory management
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSkillInput } from "../agents/skills.ts";
import { CHAIN_RUNS_DIR, type AcceptanceInput, type JsonSchemaObject, type OutputMode, type ToolBudgetConfig } from "./types.ts";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
	return output === "false" ? false : output;
}

// =============================================================================
// Chain Step Types
// =============================================================================

/** Sequential step: single generic child execution */
export interface SequentialStep {
	agent?: string;
	task?: string;
	description?: string;
	permissions?: "full" | "read-only";
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	tier?: "light" | "standard" | "heavy";
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent?: string;
	task?: string;
	description?: string;
	permissions?: "full" | "read-only";
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	count?: number;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	tier?: "light" | "standard" | "heavy";
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
}

export interface DynamicExpandSpec {
	from: {
		output: string;
		path: string;
	};
	item?: string;
	key?: string;
	maxItems?: number;
	onEmpty?: "skip" | "fail";
}

export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;

export interface DynamicCollectSpec {
	as: string;
	outputSchema?: JsonSchemaObject;
}

export interface DynamicParallelStep {
	expand: DynamicExpandSpec;
	parallel: DynamicParallelTemplate;
	collect: DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	acceptance?: AcceptanceInput;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;

// =============================================================================
// Type Guards
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

export function isDynamicParallelStep(step: ChainStep): step is DynamicParallelStep {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

/** Get display labels (description) for children in a step. */
export function getStepAgents(step: ChainStep): string[] {
	if (isParallelStep(step)) {
		return step.parallel.map((t) => t.description || t.label || t.agent || "child");
	}
	if (isDynamicParallelStep(step)) {
		return [step.parallel.description || step.parallel.label || step.parallel.agent || "child"];
	}
	return [step.description || step.label || step.agent || "child"];
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function createChainDir(runId: string, baseDir?: string): string {
	const chainDir = path.join(baseDir ? path.resolve(baseDir) : CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {
		// Chain cleanup is best-effort. Runs can already have cleaned their temp dir.
	}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
		// Startup cleanup is best-effort. If the scoped temp root is unreadable,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		try {
			const dirPath = path.join(CHAIN_RUNS_DIR, dir);
			const stat = fs.statSync(dirPath);
			if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
				fs.rmSync(dirPath, { recursive: true });
			}
		} catch {
			// Skip directories that can't be processed; continue with others
		}
	}
}

// =============================================================================
// Template Resolution
// =============================================================================

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplates(
	steps: ChainStep[],
): ResolvedTemplates {
	return steps.map((step, i) => {
		if (isParallelStep(step)) {
			// Parallel step: resolve each task's template
			return step.parallel.map((task) => {
				if (task.task) return task.task;
				// Default for parallel tasks is {previous}
				return "{previous}";
			});
		}
		if (isDynamicParallelStep(step)) {
			return step.parallel.task ?? "{previous}";
		}
		// Sequential step: existing logic
		const seq = step as SequentialStep;
		if (seq.task) return seq.task;
		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > false (disabled). Children have no named-agent defaults.
 */
export function resolveStepBehavior(
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output = stepOutput !== undefined ? stepOutput : false;
	const reads = stepOverrides.reads !== undefined ? stepOverrides.reads : false;
	const progress = stepOverrides.progress !== undefined ? stepOverrides.progress : false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	} else {
		skills = chainSkills && chainSkills.length > 0 ? [...chainSkills] : [];
	}

	const outputMode = stepOverrides.outputMode ?? "inline";
	const model = stepOverrides.model;
	return { output, outputMode, reads, progress, skills, model };
}

export function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined {
	if (!task) return originalTask;
	return originalTask ? task.replaceAll("{task}", originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return /\breview[- ]only\b/i.test(task)
		|| /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
		|| /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
		|| /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
		|| /\bleave\s+files?\s+unchanged\b/i.test(task);
}

export function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior {
	const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
	return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}

// =============================================================================
// Chain Instruction Injection
// =============================================================================

/**
 * Resolve a file path: absolute paths pass through, relative paths get chainDir prepended.
 */
function resolveChainPath(filePath: string, chainDir: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function writeInitialProgressFile(progressDir: string): void {
	fs.mkdirSync(progressDir, { recursive: true });
	fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}

export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
): { prefix: string; suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];

	// READS - prepend to override any hardcoded filenames in task text
	if (behavior.reads && behavior.reads.length > 0) {
		const files = behavior.reads.map((f) => resolveChainPath(f, chainDir));
		prefixParts.push(`[Read from: ${files.join(", ")}]`);
	}

	// OUTPUT - prepend so agent knows where to write
	if (behavior.output) {
		const outputPath = resolveChainPath(behavior.output, chainDir);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	// Progress instructions in suffix (less critical)
	if (behavior.progress) {
		const progressPath = path.join(chainDir, "progress.md");
		if (isFirstProgressAgent) {
			suffixParts.push(`Create and maintain progress at: ${progressPath}`);
		} else {
			suffixParts.push(`Update progress at: ${progressPath}`);
		}
	}

	// Include previous step's summary in suffix if available
	if (previousSummary && previousSummary.trim()) {
		suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
	}

	const prefix = prefixParts.length > 0 
		? prefixParts.join("\n") + "\n\n"
		: "";
	
	const suffix = suffixParts.length > 0
		? "\n\n---\n" + suffixParts.join("\n")
		: "";

	return { prefix, suffix };
}

// =============================================================================
// Parallel Step Support
// =============================================================================

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	stepIndex: number,
	chainSkills?: string[],
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const subdir = path.join(`parallel-${stepIndex}`, String(taskIndex));
		let output: string | false = false;
		const taskOutput = normalizeOutputOverride(task.output);
		if (taskOutput !== undefined) {
			if (taskOutput === false) {
				output = false;
			} else if (path.isAbsolute(taskOutput)) {
				output = taskOutput;
			} else {
				output = path.join(subdir, taskOutput);
			}
		}

		const reads = task.reads !== undefined ? task.reads : false;
		const progress = task.progress !== undefined ? task.progress : false;
		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: string[] | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			skills = [...taskSkillInput];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		} else {
			skills = chainSkills && chainSkills.length > 0 ? [...chainSkills] : [];
		}

		const outputMode = task.outputMode ?? "inline";
		const model = task.model;
		return { output, outputMode, reads, progress, skills, model };
	});
}

/**
 * Create subdirectories for parallel step outputs
 */
export function createParallelDirs(
	chainDir: string,
	stepIndex: number,
	taskCount: number,
	agentNames: string[],
): void {
	for (let i = 0; i < taskCount; i++) {
		const subdir = path.join(chainDir, `parallel-${stepIndex}`, String(i));
		fs.mkdirSync(subdir, { recursive: true });
	}
}

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
