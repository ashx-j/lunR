/**
 * lunR: cron scheduler loop (Phase 1 of the cron/gateway roadmap).
 *
 * startScheduler() runs an unref'd, self-rescheduling setTimeout loop (default
 * 60s tick). Tick errors are caught — the loop never dies. Each tick collects
 * due jobs and runs them SEQUENTIALLY; recurring jobs are advanceNextRun()'d
 * BEFORE execution (at-most-once: a crash mid-run never double-fires).
 *
 * Per due job: build the prompt (cron-hint prefix + contextFrom upstream
 * outputs at an 8K cap each + job.prompt) → runJob → saveJobOutput →
 * [SILENT] check (whole response, or first/last line) → deliverResult.
 * Empty responses are soft failures; all failures attempt delivery of a
 * compact one-line error. Delivery errors land in job.lastDeliveryError.
 *
 * The scheduler knows nothing about delivery channels: runJob/deliverResult
 * are injected (the lunr-cron builtin extension wires the TUI + the
 * @lunr/cron-delivery bridge; the Phase 4 gateway replaces that bridge).
 */

import type { CronJob } from "./jobs.ts";
import {
	advanceNextRun,
	CONTEXT_OUTPUT_CAP,
	getDueJobs,
	getJob,
	getLatestJobOutput,
	markJobRun,
	saveJobOutput,
	updateJob,
} from "./jobs.ts";

export interface SchedulerDeps {
	/** Run one job turn; resolves with the final assistant text. */
	runJob: (prompt: string, job: CronJob) => Promise<string>;
	/** Deliver a result (or failure notice) to the job's targets. Throws on failure. */
	deliverResult: (job: CronJob, content: string) => Promise<void>;
	/** Tick interval; default 60s. */
	intervalMs?: number;
	/** Per-job wall-clock timeout; default 5 minutes. */
	jobTimeoutMs?: number;
}

export const SILENT_TAG = "[SILENT]";

/** Prefix telling the model it runs unattended and how to suppress delivery. */
export function cronPromptPrefix(job: CronJob): string {
	return `You are running as a scheduled cron job '${job.name}'. Delivery of your final response is automatic; respond with ${SILENT_TAG} to suppress delivery.`;
}

/** Whole response, or the first/last line, is exactly [SILENT] → suppress delivery. */
export function isSilent(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === SILENT_TAG) return true;
	const lines = trimmed.split("\n");
	return lines[0].trim() === SILENT_TAG || lines[lines.length - 1].trim() === SILENT_TAG;
}

/** cron-hint prefix + contextFrom upstream outputs (8K chars cap each) + job prompt. */
export function buildJobPrompt(job: CronJob): string {
	const parts = [cronPromptPrefix(job)];
	for (const upstreamId of job.contextFrom ?? []) {
		const output = getLatestJobOutput(upstreamId);
		if (output) {
			parts.push(`Latest output from cron job '${upstreamId}':\n${output.slice(0, CONTEXT_OUTPUT_CAP)}`);
		}
	}
	parts.push(job.prompt);
	return parts.join("\n\n");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function recordDeliveryError(jobId: string, error: string | null, previous: string | null): Promise<void> {
	if (error === null && previous === null) return; // avoid a pointless write
	await updateJob(jobId, { lastDeliveryError: error });
}

/** Failures always attempt delivery of a compact one-line error. */
async function deliverFailure(job: CronJob, deps: SchedulerDeps, message: string): Promise<void> {
	try {
		await deps.deliverResult(job, `Cron job '${job.name}' failed: ${oneLine(message)}`);
		await recordDeliveryError(job.id, null, job.lastDeliveryError);
	} catch (err) {
		await recordDeliveryError(job.id, errorMessage(err), job.lastDeliveryError);
	}
}

/**
 * Execute one due job through the full pipeline. Never throws — run errors,
 * empty responses and delivery errors are recorded on the job.
 */
export async function executeJob(job: CronJob, deps: SchedulerDeps): Promise<void> {
	let text: string;
	try {
		text = await deps.runJob(buildJobPrompt(job), job);
	} catch (err) {
		const message = errorMessage(err);
		await markJobRun(job.id, { status: "error", error: message });
		await deliverFailure(job, deps, message);
		return;
	}

	if (!text.trim()) {
		// Empty response = soft failure.
		await markJobRun(job.id, { status: "error", error: "empty response" });
		await deliverFailure(job, deps, "empty response");
		return;
	}

	await saveJobOutput(job.id, text);
	if (isSilent(text)) {
		// Output is saved; delivery is suppressed.
		await markJobRun(job.id, { status: "ok" });
		return;
	}

	let deliveryError: string | null = null;
	try {
		await deps.deliverResult(job, text);
	} catch (err) {
		deliveryError = errorMessage(err);
	}
	await markJobRun(job.id, { status: "ok" });
	await recordDeliveryError(job.id, deliveryError, job.lastDeliveryError);
}

/** One scheduler tick: run every due job sequentially. Exported for tests. */
export async function runSchedulerTick(deps: SchedulerDeps, now: Date = new Date()): Promise<void> {
	const due = await getDueJobs(now);
	const jobTimeoutMs = deps.jobTimeoutMs ?? 5 * 60 * 1000;
	for (const dueJob of due) {
		if (dueJob.schedule.kind !== "once") await advanceNextRun(dueJob.id);
		const job = getJob(dueJob.id);
		let timedOut = false;
		const executePromise = executeJob(job, deps);
		const timeoutPromise = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`timed out after ${jobTimeoutMs}ms`));
			}, jobTimeoutMs);
			// If executeJob finishes, this promise is discarded; the timer must not keep the process alive.
			timer.unref?.();
		});
		try {
			await Promise.race([executePromise, timeoutPromise]);
		} catch (err) {
			if (!timedOut) throw err;
			const message = err instanceof Error ? err.message : String(err);
			await markJobRun(job.id, { status: "error", error: message });
			await deliverFailure(job, deps, message);
		}
	}
}

/**
 * Start the scheduler loop. Unref'd so it never keeps the process alive;
 * tick errors are swallowed so the loop never dies.
 */
export function startScheduler(deps: SchedulerDeps): { stop(): void } {
	const intervalMs = deps.intervalMs ?? 60_000;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const loop = async (): Promise<void> => {
		if (stopped) return;
		try {
			await runSchedulerTick(deps);
		} catch {
			// never kill the loop
		}
		if (stopped) return;
		timer = setTimeout(loop, intervalMs);
		timer.unref?.();
	};

	timer = setTimeout(loop, intervalMs);
	timer.unref?.();

	return {
		stop(): void {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}
