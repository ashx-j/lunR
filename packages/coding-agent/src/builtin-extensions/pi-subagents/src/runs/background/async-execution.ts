// @ts-nocheck
/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeChildSpec } from "../../shared/child-spec.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { snapshotParentPermissionMode } from "../../../../../core/subagent-permission-inherit.ts";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveEffectiveSubagentModel, resolveModelCandidate, resolveRequiredTierModel, resolveSubagentModelOverride, type AvailableModelInfo, type ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import {
	type AcceptanceInput,
	type ArtifactConfig,
	type ChildSpec,
	type Details,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SubagentRunMode,
	type SteeringRecoveryDescriptor,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { initialTurnBudgetState } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import type { ImportedAsyncRoot } from "./chain-root-attachment.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => piPackageRoot ? path.join(piPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

const jitiCliPath = resolveJitiCliPath();

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	/** Parent session id used by permission-system ask forwarding. */
	parentSessionId?: string;
	currentModelProvider?: string;
	currentModel?: ParentModel;
	/** Optional model-scope enforcement resolved from subagent settings. */
	modelScope?: ModelScopeConfig;
}

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: Exclude<SubagentRunMode, "single">;
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (string | false | undefined)[];
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within the async run. */
	globalConcurrencyLimit?: number;
}

interface AsyncSingleParams {
	spec: ChildSpec;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionDir?: string;
	sessionFile?: string;
	revivalLease?: SessionLeaseRequest;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputBaseDir?: string;
	modelOverride?: string;
	thinkingOverride?: string | false;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	absoluteDeadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface AsyncRunnerStepBuildParams {
	chain: ChainStep[];
	task?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: SubagentRunMode;
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (string | false | undefined)[];
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeBaseDir?: string;
	asyncDir: string;
	outputBaseDir?: string;
	validateOutputBindings?: boolean;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
	/** Optional collision-free ChildSpec id namespace for steps appended to a live run. */
	childIdRunId?: string;
}

export type AsyncRunnerStepBuildResult =
	| {
		steps: RunnerStep[];
		runnerCwd: string;
		workflowGraph: ReturnType<typeof buildWorkflowGraphSnapshot>;
		eventChain: ChainStep[];
		originalTask?: string;
	}
	| { error: string };

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. When you have nothing left to do until the async result arrives, call subagent_wait() — it blocks until the run finishes and delivers the completion here. Only if you are certain you will get another turn (an interactive session where the user will prompt you again) can you instead stop and let Pi wake you; inside a skill that must run to completion, or in a non-interactive run, there is no next turn, so use subagent_wait().",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need a one-shot status/result or to inspect a blocked/stale run. To block until completion, prefer subagent_wait(). Do not poll in a loop just to wait.",
	].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

function isNodeExecutableName(execPath: string): boolean {
	const basename = path.basename(execPath).toLowerCase();
	return basename === "node" || basename === "node.exe" || basename === "nodejs" || basename === "nodejs.exe";
}

function canUseCurrentNodeExecutable(execPath: string): boolean {
	try {
		fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveAsyncRunnerNodeCommand(): string {
	if (isNodeExecutableName(process.execPath) && canUseCurrentNodeExecutable(process.execPath)) {
		return process.execPath;
	}
	return process.platform === "win32" ? "node.exe" : "node";
}

export function resolveAsyncRunnerLogPaths(cfg: object): { stdoutPath: string; stderrPath: string } | undefined {
	const asyncDir = typeof (cfg as { asyncDir?: unknown }).asyncDir === "string"
		? (cfg as { asyncDir: string }).asyncDir
		: undefined;
	if (!asyncDir) return undefined;
	return {
		stdoutPath: path.join(asyncDir, "runner.stdout.log"),
		stderrPath: path.join(asyncDir, "runner.stderr.log"),
	};
}

function closeFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best-effort cleanup; child process already owns its duplicated stdio fd.
	}
}

/**
 * Spawn the async runner process
 */
const RUNNER_STARTUP_TIMEOUT_MS = 10_000;
const RUNNER_STARTUP_WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const RUNNER_STARTUP_WAIT_VIEW = RUNNER_STARTUP_WAIT_BUFFER ? new Int32Array(RUNNER_STARTUP_WAIT_BUFFER) : undefined;

type RunnerStartupState = "ready" | "acknowledged";

type RunnerStartupWaitResult =
	| { ok: true; token: string }
	| { ok: false; error: string };

function waitForStartupInterval(delayMs = 20): void {
	if (RUNNER_STARTUP_WAIT_VIEW) {
		Atomics.wait(RUNNER_STARTUP_WAIT_VIEW, 0, 0, delayMs);
		return;
	}
	const waitUntil = Date.now() + delayMs;
	while (Date.now() < waitUntil) {
		// Startup handshakes are synchronous so resume rejects before reporting a run as started.
	}
}

function readRunnerStartup(startupPath: string, expectedState: RunnerStartupState, expectedToken?: string): RunnerStartupWaitResult | undefined {
	if (!fs.existsSync(startupPath)) return undefined;
	try {
		const payload = JSON.parse(fs.readFileSync(startupPath, "utf-8")) as { state?: unknown; token?: unknown; error?: unknown };
		if (payload.state === "error" && typeof payload.error === "string") return { ok: false, error: payload.error };
		if (payload.state !== expectedState) return undefined;
		if (typeof payload.token !== "string" || (expectedToken !== undefined && payload.token !== expectedToken)) {
			return { ok: false, error: `Async runner wrote an invalid ${expectedState} startup handshake: ${startupPath}` };
		}
		return { ok: true, token: payload.token };
	} catch (error) {
		return { ok: false, error: `Failed to read async runner startup handshake '${startupPath}': ${error instanceof Error ? error.message : String(error)}` };
	}
}

function waitForRunnerStartup(startupPath: string, expectedState: RunnerStartupState, timeoutMs: number, expectedToken?: string): RunnerStartupWaitResult {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = readRunnerStartup(startupPath, expectedState, expectedToken);
		if (result) return result;
		if (Date.now() >= deadline) break;
		waitForStartupInterval(Math.min(20, Math.max(1, deadline - Date.now())));
	}
	const finalResult = readRunnerStartup(startupPath, expectedState, expectedToken);
	if (finalResult) return finalResult;
	return { ok: false, error: `Timed out after ${timeoutMs}ms waiting for the async runner startup state '${expectedState}'.` };
}

function writeRunnerStartupControl(filePath: string, payload: { action: "ack" | "proceed"; token: string }): void {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Preserve the startup-control write error.
		}
		throw error;
	}
}

function runnerIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function terminateRunnerBeforeProceed(pid: number): void {
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!runnerIsAlive(pid)) return;
		try {
			process.kill(pid, signal);
		} catch {
			if (!runnerIsAlive(pid)) return;
		}
		const deadline = Date.now() + 1000;
		while (runnerIsAlive(pid) && Date.now() < deadline) waitForStartupInterval();
	}
}

function spawnRunner(cfg: object, suffix: string, cwd: string): { pid?: number; error?: string } {
	if (!jitiCliPath) {
		return { error: "upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	// lunr: bake-in ships compiled .js only; use the .ts when present (upstream dev), else the .js sibling.
	const runnerTsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	const runner = fs.existsSync(runnerTsPath) ? runnerTsPath : runnerTsPath.replace(/\.ts$/, ".js");
	const nodeCommand = resolveAsyncRunnerNodeCommand();
	const startupPath = typeof (cfg as { revivalLease?: unknown; asyncDir?: unknown }).revivalLease === "object"
		&& typeof (cfg as { asyncDir?: unknown }).asyncDir === "string"
		? path.join((cfg as { asyncDir: string }).asyncDir, "runner-startup.json")
		: undefined;
	const startupAckPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-ack.json") : undefined;
	const startupProceedPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-proceed.json") : undefined;
	if (startupPath) fs.rmSync(startupPath, { force: true });
	if (startupAckPath) fs.rmSync(startupAckPath, { force: true });
	if (startupProceedPath) fs.rmSync(startupProceedPath, { force: true });

	const logPaths = resolveAsyncRunnerLogPaths(cfg);
	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	try {
		if (logPaths) {
			fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
			stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
			stderrFd = fs.openSync(logPaths.stderrPath, "a");
		}
		const proc = spawn(nodeCommand, [jitiCliPath, runner, cfgPath], {
			cwd,
			detached: true,
			stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
			windowsHide: true,
			env: {
				...process.env,
				...(piPackageRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piPackageRoot } : {}),
			},
		});
		closeFd(stdoutFd);
		closeFd(stderrFd);
		proc.on("error", (error) => {
			console.error(`[pi-subagents] async spawn failed: ${error.message}`);
		});
		if (typeof proc.pid !== "number") {
			return { error: `async runner did not produce a pid for cwd: ${cwd}` };
		}
		proc.unref();
		if (startupPath && startupAckPath && startupProceedPath) {
			const ready = waitForRunnerStartup(startupPath, "ready", RUNNER_STARTUP_TIMEOUT_MS);
			if (!ready.ok) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: ready.error };
			}
			try {
				writeRunnerStartupControl(startupAckPath, { action: "ack", token: ready.token });
			} catch (error) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: `Failed to acknowledge async runner startup: ${error instanceof Error ? error.message : String(error)}` };
			}
			const acknowledged = waitForRunnerStartup(startupPath, "acknowledged", RUNNER_STARTUP_TIMEOUT_MS, ready.token);
			if (!acknowledged.ok) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: acknowledged.error };
			}
			try {
				writeRunnerStartupControl(startupProceedPath, { action: "proceed", token: ready.token });
			} catch (error) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: `Failed to authorize async runner startup: ${error instanceof Error ? error.message : String(error)}` };
			}
			try {
				fs.rmSync(startupPath, { force: true });
			} catch {
				// Proceed is the commit point; handshake cleanup cannot turn a running revival into a start error.
			}
		}
		return { pid: proc.pid };
	} catch (error) {
		closeFd(stdoutFd);
		closeFd(stderrFd);
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

function childDescription(step: Pick<SequentialStep, "description" | "label" | "agent">): string {
	return step.description || step.label || step.agent || "child";
}

export function buildAsyncRunnerSteps(id: string, params: AsyncRunnerStepBuildParams): AsyncRunnerStepBuildResult {
	const {
		chain,
		ctx,
		cwd,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeBaseDir,
		asyncDir,
	} = params;
	const outputBaseDir = params.outputBaseDir;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const progressDir = params.progressDir ?? runnerCwd;
	const graphChain: ChainStep[] = params.attachRoot
		? [{
				agent: params.attachRoot.agent,
				task: `Attach async root ${params.attachRoot.runId}`,
				label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
				...(params.attachRoot.outputName ? { as: params.attachRoot.outputName } : {}),
			}, ...chain]
		: chain;
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		if (params.validateOutputBindings !== false) {
			validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
		}
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return { error: error.message };
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: graphChain });

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model !== undefined ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior, flatIndex?: number, parallelOutputNamespace?: { stepIndex: number; taskIndex?: number }) => {
		const childIndex = flatIndex ?? parallelOutputNamespace?.stepIndex ?? 0;
		const spec = normalizeChildSpec(s, {
			parentMode: snapshotParentPermissionMode(ctx.parentSessionId ?? ctx.currentSessionId),
			runId: params.childIdRunId ?? id,
			index: childIndex,
			childId: s.childId ?? (s.agent?.trim() ? s.agent : undefined),
			defaultTask: "{previous}",
			fanoutAuthorized: false,
		});
		const toolBudgetInput = spec.toolBudget ?? params.toolBudget ?? params.configToolBudget;
		const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, spec.toolBudget ? "toolBudget" : "config.toolBudget");
		if (resolvedToolBudget.error) throw new AsyncStartValidationError(resolvedToolBudget.error);
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		let behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(buildStepOverrides(s), chainSkills), s.task, originalTask);
		const inheritedRelativeParallelOutput = parallelOutputNamespace && s.output === undefined && typeof behavior.output === "string" && !path.isAbsolute(behavior.output);
		if (inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex !== undefined) {
			behavior = {
				...behavior,
				output: path.join(`parallel-${parallelOutputNamespace.stepIndex}`, String(parallelOutputNamespace.taskIndex), behavior.output),
			};
		}
		const namespaceOutputPath = Boolean(inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex === undefined);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
			skillNames,
			stepCwd,
			ctx.cwd,
			undefined,
			stepCwd,
		);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}
		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, progressDir, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd, outputBaseDir);
		if (!namespaceOutputPath) systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, {
			tools: spec.effectivePermissions === "read-only" ? ["read", "grep", "find", "ls", "bash"] : undefined,
		});
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${spec.description})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const taskText = `${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`;
		const task = namespaceOutputPath ? taskText : injectSingleOutputInstruction(taskText, outputPath, {
			tools: spec.effectivePermissions === "read-only" ? ["read", "grep", "find", "ls", "bash"] : undefined,
		});

		const primaryModel = resolveRequiredTierModel(spec.tier, availableModels, ctx.currentModelProvider);
		const thinkingOverride = flatIndex === undefined ? undefined : thinkingOverridesByFlatIndex?.[flatIndex];
		const effectiveThinking = thinkingOverride;
		const model = applyThinkingSuffix(primaryModel, effectiveThinking, thinkingOverride !== undefined);
		return {
			parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
			parentPermissionMode: snapshotParentPermissionMode(ctx.parentSessionId ?? ctx.currentSessionId),
			childId: spec.childId,
			description: spec.description,
			permissions: spec.effectivePermissions,
			tier: spec.tier,
			agent: spec.description,
			task,
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, effectiveThinking),
			...(spec.modelSelection ? { modelSelection: spec.modelSelection } : {}),
			modelCandidates: buildModelCandidates(primaryModel, undefined, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
				applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined),
			),
			systemPrompt,
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: false,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			...(namespaceOutputPath ? { namespaceOutputPath: true } : {}),
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth,
			waitToolEnabled: params.waitToolEnabled,
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: spec.description,
				permissions: spec.effectivePermissions,
				task,
				mode: resultMode,
				async: true,
				dynamic: false,
			}),
			acceptanceInput: s.acceptance,
			acceptanceRole: spec.effectivePermissions === "read-only" ? "read-only" : "writer",
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextFlatStep = (): { index: number; sessionFile?: string; thinkingOverride?: string | false } => {
		const index = flatStepIndex;
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		const thinkingOverride = thinkingOverridesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return {
			index,
			...(sessionFile ? { sessionFile } : {}),
			...(thinkingOverride ? { thinkingOverride } : {}),
		};
	};

	try {
		const builtSteps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					return suppressProgressForReadOnlyTask(resolveStepBehavior(buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree || params.progressDir) writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex, worktreeBaseDir);
							} catch {
								behaviorCwd = undefined;
							}
						}
						const staticStep = nextFlatStep();
						return buildSeqStep(t, staticStep.sessionFile, behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex], staticStep.index, { stepIndex, taskIndex });
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			if (isDynamicParallelStep(s)) {
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				const maxItems = s.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0;
				const dynamicFlatSteps = Array.from({ length: maxItems }, () => nextFlatStep());
				const parallel = buildSeqStep(s.parallel as SequentialStep, undefined, undefined, progressPrecreated, behavior, undefined, { stepIndex });
				return {
					expand: s.expand,
					parallel,
					collect: s.collect,
					concurrency: s.concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					sessionFiles: dynamicFlatSteps.map((step) => step.sessionFile),
					thinkingOverrides: dynamicFlatSteps.map((step) => step.thinkingOverride),
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.description,
						permissions: s.parallel.permissions === "read-only" ? "read-only" : "full",
						task: parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
					}),
					acceptanceInput: s.acceptance,
					acceptanceRole: s.parallel.permissions === "read-only" ? "read-only" : "writer",
				};
			}
			const staticStep = nextFlatStep();
			return buildSeqStep(s as SequentialStep, staticStep.sessionFile, undefined, false, undefined, staticStep.index);
		});
		const steps = params.attachRoot
			? [{
					agent: params.attachRoot.agent,
					task: "",
					label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
					outputName: params.attachRoot.outputName,
					importAsyncRoot: {
						runId: params.attachRoot.runId,
						asyncDir: params.attachRoot.asyncDir,
						resultPath: params.attachRoot.resultPath,
						index: params.attachRoot.index,
					},
					inheritProjectContext: false,
					inheritSkills: false,
				}, ...builtSteps]
			: builtSteps;
		for (const step of steps) {
			if (!("parallel" in step) || !Array.isArray(step.parallel)) continue;
			const seen = new Map<string, { index: number; agent: string }>();
			for (let index = 0; index < step.parallel.length; index++) {
				const task = step.parallel[index]!;
				if (!task.outputPath) continue;
				const previous = seen.get(task.outputPath);
				if (previous) {
					throw new AsyncStartValidationError(`Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${task.outputPath}. Use distinct output paths.`);
				}
				seen.set(task.outputPath, { index, agent: task.agent });
			}
		}
		return { steps, runnerCwd, workflowGraph, eventChain: graphChain, ...(originalTask !== undefined ? { originalTask } : {}) };
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return { error: error.message };
		throw error;
	}
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	const built = buildAsyncRunnerSteps(id, {
		chain,
		task: params.task,
		attachRoot: params.attachRoot,
		resultMode,
		ctx,
		availableModels: params.availableModels,
		cwd,
		chainSkills: params.chainSkills,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		progressDir: params.progressDir ?? (artifactsDir ? path.join(artifactsDir, "progress", id) : resultMode === "parallel" ? path.join(asyncDir, "progress") : undefined),
		outputBaseDir: artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined,
		dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
		maxSubagentDepth,
		waitToolEnabled: params.waitToolEnabled,
		worktreeBaseDir,
		asyncDir,
		toolBudget: params.toolBudget,
		configToolBudget: params.configToolBudget,
	});
	if ("error" in built) {
		try {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup for validation failures before the runner is spawned.
		}
		return formatAsyncStartError(resultMode, built.error);
	}
	const { steps, runnerCwd, workflowGraph, eventChain } = built;
	const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if (!("parallel" in step) && step.importAsyncRoot) {
			childTargetIndex++;
			return [undefined];
		}
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.childId ?? task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.childId ?? step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				timeoutMs: params.timeoutMs,
				deadlineAt,
				globalConcurrencyLimit: params.globalConcurrencyLimit,
				workflowGraph,
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const eventFirstStep = eventChain[0];
		const firstAgents = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel.map(childDescription)
			: isDynamicParallelStep(eventFirstStep)
				? [childDescription(eventFirstStep.parallel)]
			: [childDescription(eventFirstStep as SequentialStep)];
		const firstTask = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel[0]?.task
			: isDynamicParallelStep(eventFirstStep)
				? eventFirstStep.parallel.task
				: (eventFirstStep as SequentialStep).task;
		const workflowGoal = params.goal ?? (params.task?.trim() || firstTask);
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < eventChain.length; stepIndex++) {
			const step = eventChain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map(childDescription));
				flatStepStart += step.parallel.length;
			} else if (isDynamicParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
				flatAgents.push(childDescription(step.parallel));
				flatStepStart++;
			} else {
				flatAgents.push(childDescription(step as SequentialStep));
				flatStepStart++;
			}
		}
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTargets?.[0],
						intercomTarget: childIntercomTargets?.[0],
						ownerState: "live",
						mode: resultMode,
						state: "running",
						agent: firstAgents[0],
						agents: flatAgents,
						chainStepCount: eventChain.length,
						parallelGroups,
						...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: firstTask?.slice(0, 50),
			goal: workflowGoal?.slice(0, 120),
			chain: eventChain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map(childDescription).join("+")}]` : isDynamicParallelStep(s) ? `expand:${childDescription(s.parallel)}` : childDescription(s as SequentialStep),
			),
			chainStepCount: eventChain.length,
			parallelGroups,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			nestedRoute,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map(childDescription).join("+")}]` : isDynamicParallelStep(s) ? `expand:${childDescription(s.parallel)}` : childDescription(s as SequentialStep),
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		spec,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const agent = spec.description;
	const task = spec.task;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? (spec.skill === false ? [] : normalizeSkillInput(spec.skill) ?? []);
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		runnerCwd,
		ctx.cwd,
		undefined,
		runnerCwd,
	);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output ?? spec.output, typeof spec.output === "string" ? spec.output : undefined);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd, params.outputBaseDir ?? (artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined));
	const childToolShape = { tools: spec.effectivePermissions === "read-only" ? ["read", "grep", "find", "ls", "bash"] : undefined };
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, childToolShape);
	const outputMode = params.outputMode ?? spec.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath, childToolShape);
	const primaryModel = resolveRequiredTierModel(spec.tier, availableModels, ctx.currentModelProvider);
	const effectiveThinking = params.thinkingOverride;
	const model = applyThinkingSuffix(primaryModel, effectiveThinking, params.thinkingOverride !== undefined);
	const toolBudgetInput = params.toolBudget ?? spec.toolBudget ?? params.configToolBudget;
	const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, params.toolBudget || spec.toolBudget ? "toolBudget" : "config.toolBudget");
	if (resolvedToolBudget.error) return formatAsyncStartError("single", resolvedToolBudget.error);
	const deadlineAt = params.absoluteDeadlineAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	const timeoutMs = params.absoluteDeadlineAt !== undefined && deadlineAt !== undefined
		? deadlineAt - Date.now()
		: params.timeoutMs;
	if (timeoutMs !== undefined && timeoutMs <= 0) return formatAsyncStartError("single", "The source run's absolute deadline expired before recovery could launch.");
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	const resolvedSessionDir = params.sessionDir ?? (sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined);
	const resolvedAcceptance = resolveEffectiveAcceptance({
		explicit: params.acceptance ?? spec.acceptance,
		agentName: agent,
		permissions: spec.effectivePermissions,
		task,
		mode: "single",
		async: true,
	});
	const recoveryDescriptor: SteeringRecoveryDescriptor = {
		version: 4,
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		sourceRunId: id,
		childId: spec.childId,
		description: spec.description,
		permissions: spec.effectivePermissions,
		agent,
		...(sessionFile ? { sessionFile } : {}),
		cwd: runnerCwd,
		...(model ? { model } : {}),
		tier: spec.tier,
		...(effectiveThinking ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
		...(spec.modelSelection ? { modelSelection: spec.modelSelection } : {}),
		...(resolvedSkills.length ? { skills: resolvedSkills.map((skill) => skill.name) } : {}),
		...(outputPath ? { outputPath } : {}),
		outputMode,
		...(resolvedAcceptance ? { acceptance: resolvedAcceptance } : {}),
		...(controlConfig ? { controlConfig } : {}),
		...(deadlineAt !== undefined ? { absoluteDeadlineAt: deadlineAt } : {}),
		...(params.turnBudget ? { initialTurnBudget: params.turnBudget } : {}),
		...(resolvedToolBudget.budget ? { initialToolBudget: resolvedToolBudget.budget } : {}),
		maxSubagentDepth,
		...(maxOutput ? { maxOutput } : {}),
		share: shareEnabled,
		...(resolvedSessionDir ? { sessionDir: resolvedSessionDir } : {}),
		...(artifactsDir ? { artifactsDir } : {}),
		artifactConfig,
	};
	try {
		writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recoveryDescriptor);
	} catch (error) {
		return formatAsyncStartError("single", `Failed to persist async recovery descriptor for '${id}': ${error instanceof Error ? error.message : String(error)}`);
	}
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
						parentPermissionMode: snapshotParentPermissionMode(ctx.parentSessionId ?? ctx.currentSessionId),
						childId: spec.childId,
						description: spec.description,
						permissions: spec.effectivePermissions,
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model,
						thinking: resolveEffectiveThinking(model, effectiveThinking),
						...(spec.modelSelection ? { modelSelection: spec.modelSelection } : {}),
						modelCandidates: buildModelCandidates(primaryModel, undefined, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
							applyThinkingSuffix(candidate, effectiveThinking, params.thinkingOverride !== undefined),
						),
						systemPrompt,
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritSkills: false,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth,
						waitToolEnabled: params.waitToolEnabled,
						effectiveAcceptance: resolvedAcceptance,
						...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
					},
				],
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: resolvedSessionDir,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				timeoutMs,
				deadlineAt,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(spec.childId, 0)] : undefined,
				resultMode: "single",
				...(params.revivalLease ? { revivalLease: params.revivalLease } : {}),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			goal: (params.goal ?? task).slice(0, 120),
			cwd: runnerCwd,
			asyncDir,
			...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			nestedRoute,
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
	};
}
