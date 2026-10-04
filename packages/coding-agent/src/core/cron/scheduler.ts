/**
 * lunR: cron scheduler loop (Phase 1 of the cron/gateway roadmap).
 *
 * startScheduler() runs an unref'd, self-rescheduling setTimeout loop (default
 * 60s tick). Tick errors are caught — the loop never dies. Each tick collects
 * due jobs and runs them sequentially under a profile lease and durable occurrence
 * claims. Interrupted work pauses for deliberate retry.
 *
 * Per due job: build the prompt (cron-hint prefix + contextFrom upstream
 * outputs at an 8K cap each + job.prompt) → runJob → saveJobOutput →
 * [SILENT] check (whole response, or first/last line) → deliverResult.
 * Empty responses are soft failures; all failures attempt delivery of a
 * compact one-line error. Delivery errors land in job.lastDeliveryError.
 *
 * The scheduler knows nothing about delivery channels: runJob/deliverResult
 * are injected by the TUI extension or gateway operator.
 */

import type { CronJob } from "./jobs.ts";
import {
	acquireSchedulerLease,
	CONTEXT_OUTPUT_CAP,
	claimJobRun,
	deferJobRun,
	getDueJobs,
	getLatestJobOutput,
	markJobRun,
	recoverInterruptedRuns,
	saveJobOutput,
	updateJob,
} from "./jobs.ts";

export interface SchedulerDeps {
	/** Run one admitted turn. Await owned cancellation cleanup before resolving or rejecting. */
	runJob: (prompt: string, job: CronJob, signal: AbortSignal) => Promise<string>;
	/** Deliver a result (or failure notice) to the job's targets. Throws on failure. */
	deliverResult: (job: CronJob, content: string) => Promise<void>;
	/** Idle check before claiming; atomic admission must still be enforced by runJob. */
	canRun?: () => boolean;
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
	try {
		await updateJob(jobId, { lastDeliveryError: error });
	} catch (err) {
		if (!String(err).includes("no cron job matches")) throw err;
	}
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

/** Admission failed before dispatch. Keep the occurrence due instead of recording a run. */
export class CronAdmissionDeferred extends Error {}

/** One owned execution, including cooperative cancellation settlement and its terminal result. */
export async function executeJob(
	job: CronJob,
	deps: SchedulerDeps,
	stopSignal?: AbortSignal,
): Promise<{ status: "settled" } | { status: "deferred"; reason: string }> {
	const controller = new AbortController();
	const cancel = () => controller.abort(stopSignal?.reason ?? new Error("scheduler stopped"));
	stopSignal?.addEventListener("abort", cancel, { once: true });
	if (stopSignal?.aborted) cancel();
	const timeoutMs = deps.jobTimeoutMs ?? 5 * 60 * 1000;
	const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
	timer.unref?.();
	let text = "";
	let failure: string | undefined;
	try {
		controller.signal.throwIfAborted();
		text = await deps.runJob(buildJobPrompt(job), job, controller.signal);
		controller.signal.throwIfAborted();
		if (!text.trim()) throw new Error("empty response");
	} catch (error) {
		if (error instanceof CronAdmissionDeferred && !controller.signal.aborted && job.activeRun) {
			await deferJobRun(job.id, job.activeRun.id);
			return { status: "deferred", reason: error.message };
		}
		failure = errorMessage(controller.signal.aborted ? controller.signal.reason : error);
	} finally {
		clearTimeout(timer);
		stopSignal?.removeEventListener("abort", cancel);
	}
	if (failure) {
		await markJobRun(job.id, { status: "error", error: failure, runId: job.activeRun?.id });
		await deliverFailure(job, deps, failure);
		return { status: "settled" };
	}
	await saveJobOutput(job.id, text);
	let deliveryError: string | null = null;
	if (!isSilent(text)) {
		try {
			await deps.deliverResult(job, text);
		} catch (error) {
			deliveryError = errorMessage(error);
		}
	}
	await markJobRun(job.id, { status: "ok", runId: job.activeRun?.id });
	await recordDeliveryError(job.id, deliveryError, job.lastDeliveryError);
	return { status: "settled" };
}

async function tick(deps: SchedulerDeps, now: Date, signal: AbortSignal): Promise<void> {
	const due = await getDueJobs(now);
	for (const dueJob of due) {
		if (signal.aborted || deps.canRun?.() === false) break;
		const job = await claimJobRun(dueJob.id, now);
		if (job) {
			if (signal.aborted) {
				await deferJobRun(job.id, job.activeRun!.id);
				break;
			}
			await executeJob(job, deps, signal);
		}
	}
}

/** A standalone tick owns the same lease as the long-lived operators. */
export async function runSchedulerTick(deps: SchedulerDeps, now: Date = new Date()): Promise<void> {
	const release = await acquireSchedulerLease();
	if (!release) return;
	try {
		await recoverInterruptedRuns();
		await tick(deps, now, new AbortController().signal);
	} finally {
		await release();
	}
}

/** First healthy operator retains ownership until all admitted work and delivery settle. */
export function startScheduler(deps: SchedulerDeps) {
	const controller = new AbortController();
	const intervalMs = deps.intervalMs ?? 60_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let release: (() => Promise<void>) | null = null;
	let active: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;
	const ready = acquireSchedulerLease().then(async (lease) => {
		release = lease;
		if (lease) {
			try {
				await recoverInterruptedRuns();
			} catch (error) {
				await lease();
				release = null;
				throw error;
			}
		}
	});
	// Attach a rejection handler immediately; the first timer may be a minute away.
	void ready.catch(() => {});
	const loop = async (): Promise<void> => {
		if (controller.signal.aborted) return;
		try {
			await ready;
			if (release && !controller.signal.aborted && !active) {
				active = tick(deps, new Date(), controller.signal);
				try {
					await active;
				} finally {
					active = undefined;
				}
			}
		} catch (error) {
			console.error("[cron] scheduler tick failed", error);
		}
		if (!controller.signal.aborted) {
			timer = setTimeout(loop, intervalMs);
			timer.unref?.();
		}
	};
	timer = setTimeout(loop, intervalMs);
	timer.unref?.();
	return {
		isOwner: () => release !== null && !controller.signal.aborted,
		async run(jobId: string): Promise<void> {
			await ready;
			if (!release) throw new Error("another process owns the cron scheduler; run the job from that operator");
			if (controller.signal.aborted) throw new Error("cron scheduler is stopping");
			if (active || deps.canRun?.() === false) throw new Error("cron operator is busy; retry when idle");
			active = (async () => {
				const job = await claimJobRun(jobId, new Date(), true);
				if (!job) throw new Error("cron job is missing or already running");
				const result = await executeJob(job, deps, controller.signal);
				if (result.status === "deferred")
					throw new CronAdmissionDeferred(`Cron job was not admitted: ${result.reason}`);
			})();
			try {
				await active;
			} finally {
				active = undefined;
			}
		},
		stop(): Promise<void> {
			if (stopping) return stopping;
			controller.abort(new Error("scheduler stopped"));
			if (timer) clearTimeout(timer);
			stopping = (async () => {
				await ready;
				try {
					await active;
				} finally {
					if (release) await release();
					release = null;
				}
			})();
			return stopping;
		},
	};
}
