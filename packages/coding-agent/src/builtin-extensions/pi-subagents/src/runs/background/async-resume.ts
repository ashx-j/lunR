// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, isSupportedSubagentLifecycleVersion, UNSUPPORTED_SUBAGENT_LIFECYCLE_MESSAGE, type AsyncStatus, type SteeringRecoveryDescriptor, type SubagentState } from "../../shared/types.ts";
import { validateChildDescription } from "../../shared/child-spec.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { deliverInterruptRequest } from "./control-channel.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export const ASYNC_RESUME_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export interface AsyncResumeOptions {
	requireSessionFile?: boolean;
}

export type AsyncResumeTarget = {
	kind: "live" | "revive";
	runId: string;
	asyncDir?: string;
	state: AsyncStatus["state"];
	agent: string;
	childId?: string;
	description?: string;
	permissions?: "full" | "read-only";
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	recoveryDescriptor?: SteeringRecoveryDescriptor;
};

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export function interruptLiveAsyncResumeTarget(input: {
	target: AsyncResumeTarget & { kind: "live" };
	state?: Pick<SubagentState, "asyncJobs">;
	kill?: KillFn;
	now?: () => number;
	resultsDir?: string;
}): { ok: true; asyncId: string } | { ok: false; message: string } {
	const asyncId = input.target.runId;
	if (!input.target.asyncDir) {
		return { ok: false, message: `Async run ${asyncId} is live but does not have an async directory to interrupt.` };
	}
	const status = reconcileAsyncRun(input.target.asyncDir, { resultsDir: input.resultsDir, kill: input.kill, now: input.now }).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return { ok: false, message: `Async run ${asyncId} is live but no interrupt-capable runner pid was found.` };
	}
	try {
		deliverInterruptRequest({
			asyncDir: input.target.asyncDir,
			pid: status.pid,
			kill: input.kill,
			signal: ASYNC_RESUME_INTERRUPT_SIGNAL,
			now: input.now,
			source: "async-resume",
		});
		const tracked = input.state?.asyncJobs.get(asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = input.now?.() ?? Date.now();
		}
		return { ok: true, asyncId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Failed to interrupt async run ${asyncId}: ${message}` };
	}
}

interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	cwd?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	results?: Array<{ agent?: string; success?: boolean; sessionFile?: string; intercomTarget?: string; model?: string; thinking?: string }>;
}

export interface AsyncRunLocation {
	asyncDir: string | null;
	resultPath: string | null;
	resolvedId?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Async result file '${source}' must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function validateOptionalString(value: Record<string, unknown>, field: string, source: string, displayField = field): string | undefined {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string") throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
	return fieldValue;
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
	const data = ensureObject(value, resultPath);
	if (!isSupportedSubagentLifecycleVersion(data.lifecycleArtifactVersion)) {
		throw new Error(UNSUPPORTED_SUBAGENT_LIFECYCLE_MESSAGE);
	}
	const resultsValue = data.results;
	let results: AsyncResultFile["results"];
	if (resultsValue !== undefined) {
		if (!Array.isArray(resultsValue)) throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
		results = resultsValue.map((entry, index) => {
			const child = ensureObject(entry, `${resultPath} results[${index}]`);
			const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
			const sessionFile = validateOptionalString(child, "sessionFile", resultPath, `results[${index}].sessionFile`);
			const intercomTarget = validateOptionalString(child, "intercomTarget", resultPath, `results[${index}].intercomTarget`);
			const model = validateOptionalString(child, "model", resultPath, `results[${index}].model`);
			const thinking = validateOptionalString(child, "thinking", resultPath, `results[${index}].thinking`);
			const success = child.success;
			if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
			return { agent, sessionFile, intercomTarget, model, thinking, ...(typeof success === "boolean" ? { success } : {}) };
		});
	}
	const success = data.success;
	if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
	return {
		id: validateOptionalString(data, "id", resultPath),
		runId: validateOptionalString(data, "runId", resultPath),
		agent: validateOptionalString(data, "agent", resultPath),
		mode: validateOptionalString(data, "mode", resultPath),
		state: validateOptionalString(data, "state", resultPath),
		cwd: validateOptionalString(data, "cwd", resultPath),
		sessionFile: validateOptionalString(data, "sessionFile", resultPath),
		model: validateOptionalString(data, "model", resultPath),
		thinking: validateOptionalString(data, "thinking", resultPath),
		...(typeof success === "boolean" ? { success } : {}),
		...(results ? { results } : {}),
	};
}

function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return validateResultFile(JSON.parse(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new Error(`${field} must not be empty.`);
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
		throw new Error(`${field} must be an async run id or prefix, not a path.`);
	}
	return value;
}

function assertInsideRoot(root: string, target: string, label: string): void {
	const rootPath = path.resolve(root);
	const targetPath = path.resolve(target);
	const relative = path.relative(rootPath, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error(`${label} must be inside ${rootPath}.`);
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
		.map((entry) => suffix ? entry.slice(0, -suffix.length) : entry)
		.sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	assertInsideRoot(resultsDir, resultPath, "Async result file");
	return fs.existsSync(resultPath) ? resultPath : null;
}

export function findAsyncRunPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	const requestedId = assertRunId(prefix, "id");
	if (!requestedId) return [];
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const matchingIds = [...new Set([
		...prefixedRunIds(asyncRoot, requestedId),
		...prefixedRunIds(resultRoot, requestedId, ".json"),
	])].sort();
	return matchingIds.map((id) => {
		const asyncDir = path.join(asyncRoot, id);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		return {
			id,
			location: {
				asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
				resultPath: exactResultPath(resultRoot, id),
				resolvedId: id,
			},
		};
	});
}

export function resolveAsyncRunLocation(params: AsyncResumeParams, asyncDirRoot: string, resultsDir: string): AsyncRunLocation {
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		const resolvedId = requestedId ?? path.basename(asyncDir);
		if (requestedId && requestedId !== path.basename(asyncDir)) {
			throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
		}
		return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
	}
	if (!requestedId) return { asyncDir: null, resultPath: null };

	const directAsyncDir = path.join(asyncRoot, requestedId);
	assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
	const directResultPath = exactResultPath(resultRoot, requestedId);
	if (fs.existsSync(directAsyncDir) || directResultPath) {
		return {
			asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
			resultPath: directResultPath,
			resolvedId: requestedId,
		};
	}

	const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
	if (matching.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	if (matching.length > 1) {
		throw new Error(`Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`);
	}
	return matching[0]!.location;
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "stopped" || result.state === "running" || result.state === "queued") {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (typeof status.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && typeof status.cwd !== "string") throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && typeof status.sessionFile !== "string") throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		status.steps.forEach((step, index) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			const stepRecord = step as Record<string, unknown>;
			if (typeof stepRecord.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
			if (stepRecord.childId !== undefined && (typeof stepRecord.childId !== "string" || !stepRecord.childId.trim())) throw new Error(`Invalid async status '${source}': steps[${index}].childId must be a non-empty string.`);
			if (stepRecord.description !== undefined) validateChildDescription(stepRecord.description, `Async status '${source}' steps[${index}].description`);
			if (stepRecord.permissions !== undefined && stepRecord.permissions !== "full" && stepRecord.permissions !== "read-only") throw new Error(`Invalid async status '${source}': steps[${index}].permissions must be full or read-only.`);
			if (stepRecord.sessionFile !== undefined && typeof stepRecord.sessionFile !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
			if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].model must be a string.`);
			if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].thinking must be a string.`);
		});
	}
}

export function readAsyncRecoveryDescriptor(asyncDir: string | undefined): SteeringRecoveryDescriptor | undefined {
	if (!asyncDir) return undefined;
	const descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
	if (!fs.existsSync(descriptorPath)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(descriptorPath, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to parse async recovery descriptor '${descriptorPath}': ${getErrorMessage(error)}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': expected an object.`);
	const parsed = value as Record<string, unknown>;
	const allowedFields = new Set([
		"version", "lifecycleArtifactVersion", "sourceRunId", "childId", "description", "permissions", "agent", "sessionFile", "cwd", "model", "thinking", "modelSelection", "skills",
		"outputPath", "outputMode", "acceptance", "sessionDir", "artifactConfig",
		"artifactsDir", "maxOutput", "controlConfig", "absoluteDeadlineAt", "initialTurnBudget", "initialToolBudget", "maxSubagentDepth", "share",
	]);
	for (const field of Object.keys(parsed)) {
		if (!allowedFields.has(field)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': unknown field '${field}'.`);
	}
	if (parsed.version !== 3) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': version must be 3.`);
	if (!isSupportedSubagentLifecycleVersion(parsed.lifecycleArtifactVersion)) throw new Error(UNSUPPORTED_SUBAGENT_LIFECYCLE_MESSAGE);
	const requiredStrings = ["sourceRunId", "childId", "description", "agent", "cwd", "outputMode"] as const;
	for (const field of requiredStrings) {
		if (typeof parsed[field] !== "string" || !(parsed[field] as string).trim()) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${field} must be a non-empty string.`);
	}
	if (parsed.permissions !== "full" && parsed.permissions !== "read-only") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': permissions must be full or read-only.`);
	validateChildDescription(parsed.description, `Async recovery descriptor '${descriptorPath}' description`);
	if (parsed.outputMode !== "inline" && parsed.outputMode !== "file-only") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': outputMode is invalid.`);
	for (const field of ["share"] as const) {
		if (typeof parsed[field] !== "boolean") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${field} must be a boolean.`);
	}
	if (!Number.isInteger(parsed.maxSubagentDepth) || (parsed.maxSubagentDepth as number) < 0) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': maxSubagentDepth must be a non-negative integer.`);
	for (const field of ["skills"] as const) {
		const item = parsed[field];
		if (item !== undefined && (!Array.isArray(item) || item.some((entry) => typeof entry !== "string" || !entry.trim()))) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${field} must contain non-empty strings.`);
	}
	for (const field of ["sessionFile", "model", "thinking", "outputPath", "sessionDir", "artifactsDir"] as const) {
		if (parsed[field] !== undefined && (typeof parsed[field] !== "string" || !(parsed[field] as string).trim())) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${field} must be a non-empty string.`);
	}
	if (parsed.modelSelection !== undefined) {
		const selection = parsed.modelSelection as { kind?: unknown; tier?: unknown };
		if (!selection || typeof selection !== "object") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': modelSelection must be an object.`);
		if (selection.kind !== "model" && selection.kind !== "inherit" && selection.kind !== "tier") {
			throw new Error(`Invalid async recovery descriptor '${descriptorPath}': modelSelection.kind is invalid.`);
		}
		if (selection.kind === "tier" && selection.tier !== "light" && selection.tier !== "standard" && selection.tier !== "heavy") {
			throw new Error(`Invalid async recovery descriptor '${descriptorPath}': modelSelection.tier is invalid.`);
		}
	}
	if (parsed.absoluteDeadlineAt !== undefined && (!Number.isFinite(parsed.absoluteDeadlineAt) || (parsed.absoluteDeadlineAt as number) <= 0)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': absoluteDeadlineAt must be a positive timestamp.`);
	if (parsed.initialTurnBudget !== undefined) {
		const result = resolveTurnBudgetConfig(parsed.initialTurnBudget, "recoveryDescriptor.initialTurnBudget");
		if (result.error) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${result.error}`);
	}
	if (parsed.initialToolBudget !== undefined) {
		const result = validateToolBudgetConfig(parsed.initialToolBudget, "recoveryDescriptor.initialToolBudget");
		if (result.error) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${result.error}`);
	}
	if (parsed.maxOutput !== undefined) {
		if (!parsed.maxOutput || typeof parsed.maxOutput !== "object" || Array.isArray(parsed.maxOutput)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': maxOutput must be an object.`);
		for (const field of ["bytes", "lines"] as const) {
			const item = (parsed.maxOutput as Record<string, unknown>)[field];
			if (item !== undefined && (!Number.isInteger(item) || (item as number) < 1)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': maxOutput.${field} must be a positive integer.`);
		}
	}
	if (parsed.artifactConfig !== undefined) {
		if (!parsed.artifactConfig || typeof parsed.artifactConfig !== "object" || Array.isArray(parsed.artifactConfig)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': artifactConfig must be an object.`);
		const artifact = parsed.artifactConfig as Record<string, unknown>;
		for (const field of ["enabled", "includeInput", "includeOutput", "includeJsonl", "includeMetadata"] as const) {
			if (typeof artifact[field] !== "boolean") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': artifactConfig.${field} must be a boolean.`);
		}
		if (artifact.includeTranscript !== undefined && typeof artifact.includeTranscript !== "boolean") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': artifactConfig.includeTranscript must be a boolean.`);
		if (!Number.isInteger(artifact.cleanupDays) || (artifact.cleanupDays as number) < 0) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': artifactConfig.cleanupDays must be a non-negative integer.`);
	}
	if (parsed.controlConfig !== undefined) {
		if (!parsed.controlConfig || typeof parsed.controlConfig !== "object" || Array.isArray(parsed.controlConfig)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig must be an object.`);
		const control = parsed.controlConfig as Record<string, unknown>;
		if (typeof control.enabled !== "boolean") throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig.enabled must be a boolean.`);
		for (const field of ["needsAttentionAfterMs", "activeNoticeAfterMs", "failedToolAttemptsBeforeAttention"] as const) {
			if (!Number.isInteger(control[field]) || (control[field] as number) < 1) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig.${field} must be a positive integer.`);
		}
		for (const field of ["activeNoticeAfterTurns", "activeNoticeAfterTokens"] as const) {
			if (control[field] !== undefined && (!Number.isInteger(control[field]) || (control[field] as number) < 1)) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig.${field} must be a positive integer.`);
		}
		if (!Array.isArray(control.notifyOn) || control.notifyOn.some((item) => item !== "active_long_running" && item !== "needs_attention")) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig.notifyOn is invalid.`);
		if (!Array.isArray(control.notifyChannels) || control.notifyChannels.some((item) => item !== "event" && item !== "async" && item !== "intercom")) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': controlConfig.notifyChannels is invalid.`);
	}
	if (parsed.acceptance !== undefined) {
		const errors = validateAcceptanceInput(parsed.acceptance, "recoveryDescriptor.acceptance");
		if (errors.length) throw new Error(`Invalid async recovery descriptor '${descriptorPath}': ${errors.join(" ")}`);
	}
	return parsed as unknown as SteeringRecoveryDescriptor;
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!fs.existsSync(resolved)) throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
	return resolved;
}

export function resolveAsyncResumeTarget(params: AsyncResumeParams, deps: AsyncResumeDeps = {}, options: AsyncResumeOptions = {}): AsyncResumeTarget {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const requireSessionFile = options.requireSessionFile ?? true;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	const reconciliation = location.asyncDir
		? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
		: undefined;
	const status = reconciliation?.status ?? null;
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const recoveryDescriptor = readAsyncRecoveryDescriptor(location.asyncDir);
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	const runId = status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
	if (recoveryDescriptor && recoveryDescriptor.sourceRunId !== runId) throw new Error(`Async run '${runId}' has a recovery descriptor for a different source run.`);
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);
	if (state === "stopped") throw new Error(`Async run '${runId}' was stopped and cannot be resumed. Start a new run instead.`);

	const statusSteps = status?.steps ?? [];
	const resultSteps = result?.results ?? [];
	const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
	const requestedIndex = params.index;
	if (requestedIndex !== undefined && !Number.isInteger(requestedIndex)) throw new Error(`Async run '${runId}' index must be an integer.`);
	const terminalStepStatuses = new Set(["complete", "completed", "failed", "paused"]);

	if (state === "running") {
		if (requestedIndex !== undefined) {
			if (requestedIndex < 0 || requestedIndex >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
			const selectedStep = statusSteps[requestedIndex];
			if (selectedStep?.status === "running") {
				return {
					kind: "live",
					runId,
					asyncDir: location.asyncDir ?? undefined,
					state,
					agent: selectedStep.agent,
					childId: selectedStep.childId,
					description: selectedStep.description,
					permissions: selectedStep.permissions,
					index: requestedIndex,
					intercomTarget: resolveSubagentIntercomTarget(runId, selectedStep.childId ?? selectedStep.agent, requestedIndex),
					cwd: status?.cwd ?? result?.cwd,
					sessionFile: selectedStep.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
					model: selectedStep.model,
					thinking: selectedStep.thinking,
					...(recoveryDescriptor ? { recoveryDescriptor } : {}),
				};
			}
			if (selectedStep?.status === "pending") throw new Error(`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`);
			if (selectedStep && !terminalStepStatuses.has(selectedStep.status)) throw new Error(`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`);
		} else {
			const running = statusSteps
				.map((step, index) => ({ step, index }))
				.filter(({ step }) => step.status === "running");
			const selected = running.length === 1 ? running[0] : undefined;
			if (!selected) {
				throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
			}
			return {
				kind: "live",
				runId,
				asyncDir: location.asyncDir ?? undefined,
				state,
				agent: selected.step.agent,
				childId: selected.step.childId,
				description: selected.step.description,
				permissions: selected.step.permissions,
				index: selected.index,
				intercomTarget: resolveSubagentIntercomTarget(runId, selected.step.childId ?? selected.step.agent, selected.index),
				cwd: status?.cwd ?? result?.cwd,
				sessionFile: selected.step.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
				model: selected.step.model,
				thinking: selected.step.thinking,
				...(recoveryDescriptor ? { recoveryDescriptor } : {}),
			};
		}
	}

	if (stepCount > 1 && requestedIndex === undefined) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
	}
	const index = requestedIndex ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Async run '${runId}' index must be an integer.`);
	if (index < 0 || index >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
	const agent = statusSteps[index]?.agent ?? resultSteps[index]?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	if (recoveryDescriptor && recoveryDescriptor.agent !== agent) throw new Error(`Async run '${runId}' has a recovery descriptor for '${recoveryDescriptor.agent}', not '${agent}'.`);
	const sessionFile = statusSteps[index]?.sessionFile
		?? resultSteps[index]?.sessionFile
		?? (stepCount === 1 ? status?.sessionFile ?? result?.sessionFile : undefined);
	if (!sessionFile && requireSessionFile) throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
	const resolvedSessionFile = sessionFile ? validateResumeSessionFile(runId, sessionFile) : undefined;
	const stepModel = statusSteps[index]?.model ?? resultSteps[index]?.model ?? (stepCount === 1 ? result?.model : undefined);
	const stepThinking = statusSteps[index]?.thinking ?? resultSteps[index]?.thinking ?? (stepCount === 1 ? result?.thinking : undefined);
	const childId = statusSteps[index]?.childId ?? resultSteps[index]?.childId;

	return {
		kind: "revive",
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		childId,
		description: statusSteps[index]?.description ?? resultSteps[index]?.description,
		permissions: statusSteps[index]?.permissions ?? resultSteps[index]?.permissions,
		index,
		intercomTarget: resolveSubagentIntercomTarget(runId, childId ?? agent, index),
		cwd: status?.cwd ?? result?.cwd,
		...(resolvedSessionFile ? { sessionFile: resolvedSessionFile } : {}),
		...(stepModel ? { model: stepModel } : {}),
		...(stepThinking ? { thinking: stepThinking } : {}),
		...(recoveryDescriptor ? { recoveryDescriptor } : {}),
	};
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		`Original run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	].filter((line): line is string => line !== undefined).join("\n");
}
