// @ts-nocheck
export interface RunnerSubagentStep {
	completionTask?: string;
	/** Session id of the direct parent session for permission-system ask forwarding. */
	parentSessionId?: string;
	/** Live parent permission mode snapshotted at spawn. */
	parentPermissionMode?: string;
	agent?: string;
	childId?: string;
	description?: string;
	permissions?: "full" | "read-only";
	tier?: import("../../shared/types.ts").ChildTier;
	task: string;
	importAsyncRoot?: {
		runId: string;
		asyncDir: string;
		resultPath: string;
		index: number;
	};
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
	cwd?: string;
	model?: string;
	thinking?: string;
	modelSelection?: import("../../shared/types.ts").ModelSelection;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	completionGuard?: boolean;
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	/** Defer the authoritative output instruction until a dynamic fanout item is materialized. */
	namespaceOutputPath?: boolean;
	outputMode?: "inline" | "file-only";
	sessionFile?: string;
	maxSubagentDepth?: number;
	waitToolEnabled?: boolean;
	structuredOutput?: {
		schema: import("../../shared/types.ts").JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	structuredOutputSchema?: import("../../shared/types.ts").JsonSchemaObject;
	effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
	acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
	acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
	toolBudget?: import("../../shared/types.ts").ResolvedToolBudget;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export interface DynamicRunnerGroup {
	expand: import("../../shared/settings.ts").DynamicExpandSpec;
	parallel: RunnerSubagentStep;
	collect: import("../../shared/settings.ts").DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	sessionFiles?: (string | undefined)[];
	thinkingOverrides?: (string | undefined)[];
	effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
	acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
	acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function isDynamicRunnerGroup(step: RunnerStep): step is DynamicRunnerGroup {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else if (isDynamicRunnerGroup(step)) {
			continue;
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = Number.MAX_SAFE_INTEGER;

// Give the first child a small head start for prompt-cache creation. All
// siblings share this one deadline, even when bounded workers reuse slots.
export const PARALLEL_COLD_START_ALLOWANCE_MS = 1000;

/** Run-wide concurrency cap, with removable waits for cancelled launches. */
export class Semaphore {
	private available: number;
	private readonly queue: Array<() => void> = [];

	constructor(limit: number) {
		this.available = Math.max(1, Math.floor(limit) || 1);
	}

	acquire(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				const index = this.queue.indexOf(grant);
				if (index !== -1) this.queue.splice(index, 1);
				reject(signal?.reason);
			};
			this.queue.push(grant);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	release(): void {
		const next = this.queue.shift();
		if (next) next();
		else this.available++;
	}
}

function waitForLaunch(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (delayMs <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
	globalSemaphore?: Semaphore,
	cancellation?: { signal?: AbortSignal; onAbort: (item: T, i: number) => R },
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	const launchDeadline = Date.now() + (safeLimit > 1 ? PARALLEL_COLD_START_ALLOWANCE_MS : 0);
	const signal = cancellation?.signal;
	let launchReady: Promise<void> | undefined;
	let next = 0;

	async function worker(): Promise<void> {
		while (next < items.length) {
			const i = next++;
			let acquired = false;
			try {
				try {
					await (i === 0 ? waitForLaunch(0, signal) : launchReady ??= waitForLaunch(launchDeadline - Date.now(), signal));
					if (globalSemaphore) {
						await globalSemaphore.acquire(signal);
						acquired = true;
					}
					signal?.throwIfAborted();
				} catch (error) {
					if (!signal?.aborted || !cancellation) throw error;
					results[i] = cancellation.onAbort(items[i], i);
					continue;
				}
				results[i] = await fn(items[i], i);
			} finally {
				if (acquired) globalSemaphore!.release();
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()));
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.timedOut
					? `TIMED OUT${r.error ? `: ${r.error}` : ""}`
					: r.exitCode === -1
					? "SKIPPED"
					: r.exitCode !== 0 && r.exitCode !== null
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = Number.MAX_SAFE_INTEGER;
