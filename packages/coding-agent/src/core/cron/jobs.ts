/**
 * lunR: cron job model + persistent store (Phase 1 of the cron/gateway roadmap).
 *
 * Jobs persist at `<agentDir>/cron/jobs.json` (`{ jobs: [...], updated_at }`),
 * agentDir resolved via getAgentDir() (honors PI_CODING_AGENT_DIR, defaults
 * ~/.lunr/agent). Writes are atomic (tmp file in the same dir + rename) and
 * serialized through an in-process promise queue — single-process, no locks.
 *
 * Per-run output goes to `<agentDir>/cron/output/<jobId>/<YYYY-MM-DD_HH-MM-SS>.md`
 * with a retention cap of the newest 50 files per job.
 *
 * Tests inject a base dir via setCronBaseDir() so no real agent dir is touched.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { Cron } from "croner";
import { getAgentDir } from "../../config.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type CronScheduleKind = "once" | "interval" | "cron";

export interface CronSchedule {
	kind: CronScheduleKind;
	/** ISO timestamp, one-shots only. */
	runAt?: string;
	/** Interval length in minutes, interval kind only. */
	minutes?: number;
	/** 5-field cron expression, cron kind only. */
	expr?: string;
}

export interface CronJobOrigin {
	platform: string;
	chatId: string;
	threadId?: string;
	chatType?: string;
}

export type CronJobState = "scheduled" | "paused" | "completed" | "error";
export type CronJobStatus = "ok" | "error";

export interface CronJob {
	id: string;
	name: string;
	prompt: string;
	schedule: CronSchedule;
	scheduleDisplay: string;
	repeat: { times: number | null; completed: number };
	enabled: boolean;
	state: CronJobState;
	createdAt: string;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: CronJobStatus | null;
	lastError: string | null;
	lastDeliveryError: string | null;
	/** "local" | "origin" | "telegram[:chatId]" | "discord[:chatId]" (comma-combinable). v1 TUI only uses "local". */
	deliver: string;
	origin?: CronJobOrigin | null;
	/** Job IDs whose latest output (8K chars cap each) is prepended to the prompt. */
	contextFrom?: string[];
	workdir?: string;
}

export interface CreateJobInput {
	prompt: string;
	/** Raw schedule input, parsed by parseSchedule(). */
	schedule: string;
	name?: string;
	/** Repetition cap; null = forever. One-shots are always times=1. */
	times?: number | null;
	deliver?: string;
	contextFrom?: string[];
	workdir?: string;
	origin?: CronJobOrigin | null;
}

export interface JobPatch {
	name?: string;
	prompt?: string;
	/** Raw schedule input; reparsed and re-anchors nextRunAt. */
	schedule?: string;
	deliver?: string;
	enabled?: boolean;
	times?: number | null;
	contextFrom?: string[];
	workdir?: string;
	origin?: CronJobOrigin | null;
	/** Internal: manual-run trigger and delivery-error bookkeeping. */
	nextRunAt?: string | null;
	lastDeliveryError?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Flat recovery grace for one-shots: fire up to 120s late. */
export const ONE_SHOT_GRACE_MS = 120_000;
/** Recurring grace window clamps: at least 120s, at most 2h. */
const MIN_GRACE_MS = 120_000;
const MAX_GRACE_MS = 7_200_000;
/** Per-job output retention. */
export const OUTPUT_RETENTION = 50;
/** Cap per upstream job output injected via contextFrom. */
export const CONTEXT_OUTPUT_CAP = 8000;

const MAX_NAME_LEN = 50;

// ---------------------------------------------------------------------------
// Paths + store state
// ---------------------------------------------------------------------------

let baseDirOverride: string | undefined;
let cache: CronJob[] | undefined;
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Override the base dir (defaults to the agent dir) and reset the in-memory
 * cache + write queue. Passing undefined restores the default. For tests.
 */
export function setCronBaseDir(dir: string | undefined): void {
	baseDirOverride = dir;
	cache = undefined;
	writeQueue = Promise.resolve();
}

function cronDir(): string {
	return join(baseDirOverride ?? getAgentDir(), "cron");
}

function jobsFile(): string {
	return join(cronDir(), "jobs.json");
}

function outputDir(jobId: string): string {
	return join(cronDir(), "output", jobId);
}

function loadJobs(): CronJob[] {
	if (cache) return cache;
	const file = jobsFile();
	if (!existsSync(file)) {
		cache = [];
		return cache;
	}
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		cache = Array.isArray(parsed?.jobs) ? (parsed.jobs as CronJob[]) : [];
	} catch {
		cache = [];
	}
	return cache;
}

/** Queue an atomic write of the in-memory store. Rejects only for the caller; the chain self-heals. */
function persist(): Promise<void> {
	const snapshot = JSON.stringify({ jobs: cache ?? [], updated_at: new Date().toISOString() }, null, 2);
	const p = writeQueue.then(() => {
		mkdirSync(cronDir(), { recursive: true });
		const tmp = join(cronDir(), `.jobs.json.${process.pid}.${Date.now()}.tmp`);
		writeFileSync(tmp, snapshot, "utf-8");
		renameSync(tmp, jobsFile());
	});
	writeQueue = p.then(
		() => undefined,
		() => undefined,
	);
	return p;
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

export interface ParsedSchedule {
	schedule: CronSchedule;
	scheduleDisplay: string;
}

const INTERVAL_RE = /^every\s+(\d+)\s*([mhd])$/i;
const DURATION_RE = /^(\d+)\s*([mhd])$/i;

function toMinutes(value: number, unit: string): number {
	const u = unit.toLowerCase();
	const factor = u === "d" ? 1440 : u === "h" ? 60 : 1;
	return value * factor;
}

/**
 * Parse a schedule input:
 *  - `every 30m` / `every 2h` / `every 1d` → interval (minutes; d = 1440)
 *  - bare `30m` / `2h` / `1d` → one-shot at now + duration
 *  - ISO timestamp → one-shot at that time
 *  - 5-field cron expression (validated via croner; throws on invalid)
 */
export function parseSchedule(input: string, now: Date = new Date()): ParsedSchedule {
	const text = input.trim().replace(/\s+/g, " ");
	if (!text) throw new Error("schedule is empty");

	const interval = INTERVAL_RE.exec(text);
	if (interval) {
		const minutes = toMinutes(Number(interval[1]), interval[2]);
		if (minutes <= 0) throw new Error(`invalid interval: "${text}"`);
		return {
			schedule: { kind: "interval", minutes },
			scheduleDisplay: `every ${Number(interval[1])}${interval[2].toLowerCase()}`,
		};
	}

	const duration = DURATION_RE.exec(text);
	if (duration) {
		const minutes = toMinutes(Number(duration[1]), duration[2]);
		if (minutes <= 0) throw new Error(`invalid duration: "${text}"`);
		const runAt = new Date(now.getTime() + minutes * 60_000).toISOString();
		return { schedule: { kind: "once", runAt }, scheduleDisplay: text };
	}

	if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
		const ts = Date.parse(text);
		if (!Number.isNaN(ts)) {
			const runAt = new Date(ts).toISOString();
			return { schedule: { kind: "once", runAt }, scheduleDisplay: runAt };
		}
	}

	if (text.split(" ").length === 5) {
		try {
			new Cron(text);
		} catch (err) {
			throw new Error(`invalid cron expression "${text}": ${err instanceof Error ? err.message : String(err)}`);
		}
		return { schedule: { kind: "cron", expr: text }, scheduleDisplay: text };
	}

	throw new Error(
		`unrecognized schedule: "${input}" (expected "every 30m", "2h", an ISO timestamp, or a 5-field cron expression)`,
	);
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

/**
 * Compute the next run time for a job:
 *  - once: the stored runAt, recoverable within a 120s grace if never run; null after that or once run.
 *  - interval: (lastRunAt ?? createdAt) + minutes.
 *  - cron: croner nextRun after (lastRunAt ?? now).
 */
export function computeNextRun(job: CronJob, now: Date = new Date()): Date | null {
	const s = job.schedule;
	if (s.kind === "once") {
		if (job.repeat.completed > 0) return null;
		if (!s.runAt) return null;
		const runAt = new Date(s.runAt);
		if (Number.isNaN(runAt.getTime())) return null;
		return now.getTime() - runAt.getTime() <= ONE_SHOT_GRACE_MS ? runAt : null;
	}
	if (s.kind === "interval") {
		const base = job.lastRunAt ? new Date(job.lastRunAt) : new Date(job.createdAt);
		return new Date(base.getTime() + (s.minutes ?? 0) * 60_000);
	}
	const cron = new Cron(s.expr!);
	return cron.nextRun(job.lastRunAt ? new Date(job.lastRunAt) : now);
}

/** Approximate schedule period in ms (recurring jobs only) for grace-window sizing. */
function periodMs(job: CronJob, now: Date): number {
	if (job.schedule.kind === "interval") return (job.schedule.minutes ?? 0) * 60_000;
	if (job.schedule.kind === "cron") {
		const cron = new Cron(job.schedule.expr!);
		const a = cron.nextRun(now);
		if (!a) return MAX_GRACE_MS;
		const b = cron.nextRun(a);
		if (!b) return MAX_GRACE_MS;
		return Math.max(b.getTime() - a.getTime(), 1);
	}
	return 0;
}

/** Next slot strictly after `after` for a recurring job. */
function nextSlotAfter(job: CronJob, after: Date): Date | null {
	if (job.schedule.kind === "interval") {
		const period = (job.schedule.minutes ?? 0) * 60_000;
		if (period <= 0) return null;
		// Step forward from the stored nextRunAt (or now) until strictly in the future of `after`.
		let slot = job.nextRunAt ? new Date(job.nextRunAt).getTime() : new Date(job.createdAt).getTime() + period;
		while (slot <= after.getTime()) slot += period;
		return new Date(slot);
	}
	if (job.schedule.kind === "cron") {
		return new Cron(job.schedule.expr!).nextRun(after);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

let workdirRoots: string[] = [process.cwd(), homedir()];
let deliverValidator: ((deliver: string, origin?: CronJobOrigin | null) => string | undefined) | undefined;

/**
 * Configure the allowed absolute roots for cron job workdirs. Relative workdirs
 * are resolved against process.cwd() and must fall under one of these roots.
 * Default roots are process.cwd() and the user's home directory.
 */
export function setCronWorkdirRoots(roots: string[]): void {
	workdirRoots = roots.map((r) => normalize(resolve(r)));
}

/**
 * Configure a deliver-target validator. When set, createJob/updateJob reject
 * deliver strings that the validator does not approve. The gateway uses this
 * to prevent delivery to arbitrary chats.
 */
export function setCronDeliverValidator(
	fn: ((deliver: string, origin?: CronJobOrigin | null) => string | undefined) | undefined,
): void {
	deliverValidator = fn;
}

/** Test seam: restore default validation state. */
export function resetCronValidators(): void {
	workdirRoots = [process.cwd(), homedir()];
	deliverValidator = undefined;
}

function isPathUnderRoot(absPath: string, root: string): boolean {
	const normRoot = normalize(root).replace(/\\$/g, "");
	const normPath = normalize(absPath).replace(/\\$/g, "");
	return normPath === normRoot || normPath.startsWith(`${normRoot}/`) || normPath.startsWith(`${normRoot}\\`);
}

function validateWorkdir(workdir: string): string | undefined {
	const candidate = resolve(workdir);
	if (isAbsolute(workdir) && !workdirRoots.some((root) => isPathUnderRoot(candidate, root))) {
		return `workdir ${workdir} is outside allowed roots`;
	}
	if (!workdirRoots.some((root) => isPathUnderRoot(candidate, root))) {
		return `workdir ${workdir} resolves outside allowed roots`;
	}
	return undefined;
}

function runDeliverValidation(deliver: string, origin?: CronJobOrigin | null): string | undefined {
	return deliverValidator?.(deliver, origin);
}

function deriveName(prompt: string): string {
	const first = prompt.split("\n")[0].replace(/\s+/g, " ").trim();
	return (first || "cron job").slice(0, MAX_NAME_LEN);
}

export async function createJob(input: CreateJobInput): Promise<CronJob> {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("createJob: prompt is empty");
	if (input.workdir) {
		const err = validateWorkdir(input.workdir);
		if (err) throw new Error(`createJob: ${err}`);
	}
	if (input.deliver) {
		const err = runDeliverValidation(input.deliver, input.origin);
		if (err) throw new Error(`createJob: ${err}`);
	}
	const now = new Date();
	const parsed = parseSchedule(input.schedule, now);
	const isOneShot = parsed.schedule.kind === "once";
	const times = isOneShot ? 1 : (input.times ?? null);
	if (times !== null && (!Number.isInteger(times) || times < 1)) {
		throw new Error(`createJob: times must be a positive integer or null, got ${times}`);
	}
	const job: CronJob = {
		id: randomUUID().replaceAll("-", "").slice(0, 12),
		name: (input.name?.trim() || deriveName(prompt)).slice(0, MAX_NAME_LEN),
		prompt,
		schedule: parsed.schedule,
		scheduleDisplay: parsed.scheduleDisplay,
		repeat: { times, completed: 0 },
		enabled: true,
		state: "scheduled",
		createdAt: now.toISOString(),
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastDeliveryError: null,
		deliver: input.deliver?.trim() || "local",
		origin: input.origin ?? null,
		contextFrom: input.contextFrom,
		workdir: input.workdir,
	};
	job.nextRunAt = computeNextRun(job, now)?.toISOString() ?? null;
	loadJobs().push(job);
	await persist();
	return job;
}

/** Look up a job by id, then by unique name. Throws when not found or when the name is ambiguous. */
export function getJob(idOrName: string): CronJob {
	const jobs = loadJobs();
	const byId = jobs.find((j) => j.id === idOrName);
	if (byId) return byId;
	const byName = jobs.filter((j) => j.name === idOrName);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`cron job name "${idOrName}" is ambiguous (${byName.length} matches: ${byName.map((j) => j.id).join(", ")})`,
		);
	}
	throw new Error(`no cron job matches "${idOrName}"`);
}

export function listJobs(): CronJob[] {
	return [...loadJobs()];
}

export async function updateJob(idOrName: string, patch: JobPatch): Promise<CronJob> {
	const job = getJob(idOrName);
	if (patch.name !== undefined) job.name = patch.name.trim().slice(0, MAX_NAME_LEN) || job.name;
	if (patch.workdir !== undefined) {
		if (patch.workdir) {
			const err = validateWorkdir(patch.workdir);
			if (err) throw new Error(`updateJob: ${err}`);
		}
		job.workdir = patch.workdir;
	}
	if (patch.deliver !== undefined) {
		const err = runDeliverValidation(patch.deliver, patch.origin ?? job.origin);
		if (err) throw new Error(`updateJob: ${err}`);
		job.deliver = patch.deliver.trim() || "local";
	}
	if (patch.prompt !== undefined) {
		const prompt = patch.prompt.trim();
		if (!prompt) throw new Error("updateJob: prompt is empty");
		job.prompt = prompt;
	}
	if (patch.schedule !== undefined) {
		const parsed = parseSchedule(patch.schedule);
		job.schedule = parsed.schedule;
		job.scheduleDisplay = parsed.scheduleDisplay;
		if (parsed.schedule.kind === "once") job.repeat.times = 1;
		job.nextRunAt = computeNextRun(job)?.toISOString() ?? null;
	}
	if (patch.enabled !== undefined) job.enabled = patch.enabled;
	if (patch.times !== undefined) {
		if (patch.times !== null && (!Number.isInteger(patch.times) || patch.times < 1)) {
			throw new Error(`updateJob: times must be a positive integer or null, got ${patch.times}`);
		}
		if (job.schedule.kind !== "once") job.repeat.times = patch.times;
	}
	if (patch.contextFrom !== undefined) job.contextFrom = patch.contextFrom;
	if (patch.origin !== undefined) job.origin = patch.origin;
	if (patch.nextRunAt !== undefined) job.nextRunAt = patch.nextRunAt;
	if (patch.lastDeliveryError !== undefined) job.lastDeliveryError = patch.lastDeliveryError;
	await persist();
	return job;
}

export async function pauseJob(idOrName: string): Promise<CronJob> {
	const job = getJob(idOrName);
	if (job.state !== "completed") job.state = "paused";
	await persist();
	return job;
}

export async function resumeJob(idOrName: string): Promise<CronJob> {
	const job = getJob(idOrName);
	if (job.state === "paused") {
		job.state = "scheduled";
		job.nextRunAt = computeNextRun(job)?.toISOString() ?? null;
	}
	await persist();
	return job;
}

export async function removeJob(idOrName: string): Promise<CronJob> {
	const job = getJob(idOrName);
	const jobs = loadJobs();
	jobs.splice(jobs.indexOf(job), 1);
	await persist();
	return job;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Jobs due to fire now. Skips disabled/paused/completed jobs and jobs without a
 * nextRunAt. One-shots fire up to 120s late (flat recovery grace); beyond that
 * they are marked state "error" and skipped. Recurring jobs whose nextRunAt is
 * older than the grace window — min(max(period/2, 120s), 2h) — are fast-forwarded
 * to their next future slot but still fire ONCE now (collapse backlog, no burst).
 */
export async function getDueJobs(now: Date = new Date()): Promise<CronJob[]> {
	const due: CronJob[] = [];
	let changed = false;
	for (const job of loadJobs()) {
		if (!job.enabled || job.state === "paused" || job.state === "completed") continue;
		if (!job.nextRunAt) continue;
		const next = new Date(job.nextRunAt).getTime();
		if (Number.isNaN(next) || now.getTime() < next) continue;

		if (job.schedule.kind === "once") {
			if (now.getTime() - next <= ONE_SHOT_GRACE_MS) {
				due.push(job);
			} else {
				job.state = "error";
				job.lastStatus = "error";
				job.lastError = "missed one-shot schedule beyond the 120s recovery grace";
				job.nextRunAt = null;
				changed = true;
			}
			continue;
		}

		const grace = Math.min(Math.max(periodMs(job, now) / 2, MIN_GRACE_MS), MAX_GRACE_MS);
		if (now.getTime() - next > grace) {
			job.nextRunAt = nextSlotAfter(job, now)?.toISOString() ?? null;
			changed = true;
		}
		due.push(job);
	}
	if (changed) await persist();
	return due;
}

/**
 * Advance a recurring job to its next slot. Called by the scheduler BEFORE
 * execution so a crash mid-run loses at most that run (at-most-once).
 */
export async function advanceNextRun(jobId: string): Promise<CronJob> {
	const job = getJob(jobId);
	if (job.schedule.kind !== "once") {
		// Advance to the first slot strictly after NOW: the job fires once for the
		// current slot, and the next fire is the next future slot (no catch-up burst).
		job.nextRunAt = nextSlotAfter(job, new Date())?.toISOString() ?? computeNextRun(job)?.toISOString() ?? null;
		await persist();
	}
	return job;
}

/**
 * Record a finished run: lastRunAt/lastStatus/lastError, repeat.completed++,
 * then either complete the job (finite repeats exhausted, one-shots included)
 * or re-anchor nextRunAt off the previous scheduled slot (no drift).
 */
export async function markJobRun(jobId: string, result: { status: CronJobStatus; error?: string }): Promise<CronJob> {
	const job = getJob(jobId);
	const now = new Date();
	job.lastRunAt = now.toISOString();
	job.lastStatus = result.status;
	job.lastError = result.error ?? null;
	job.repeat.completed += 1;
	if (job.repeat.times !== null && job.repeat.completed >= job.repeat.times) {
		job.state = "completed";
		job.nextRunAt = null;
	} else if (job.schedule.kind === "interval") {
		// Anchor to the previous scheduled slot + period to avoid cumulative drift.
		// If advanceNextRun already moved nextRunAt into the future (scheduler path),
		// keep it; otherwise (manual run) step forward from now.
		const current = job.nextRunAt ? new Date(job.nextRunAt) : now;
		if (current.getTime() > now.getTime()) {
			// Already advanced by the scheduler — keep the scheduled slot.
			job.nextRunAt = current.toISOString();
		} else {
			job.nextRunAt = nextSlotAfter(job, now)?.toISOString() ?? null;
		}
	} else if (job.schedule.kind === "cron") {
		job.nextRunAt = new Cron(job.schedule.expr!).nextRun(now)?.toISOString() ?? null;
	}
	await persist();
	return job;
}

// ---------------------------------------------------------------------------
// Per-run output
// ---------------------------------------------------------------------------

function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function parseStamp(stamp: string): Date {
	const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(stamp);
	if (!m) return new Date();
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

let lastOutputStamp = "";

/** Monotonic timestamp stamp: never collides within the process, keeps lexicographic = chronological order. */
function nextOutputStamp(): string {
	let d = new Date();
	let stamp = formatStamp(d);
	if (stamp <= lastOutputStamp) {
		d = new Date(parseStamp(lastOutputStamp).getTime() + 1000);
		stamp = formatStamp(d);
	}
	lastOutputStamp = stamp;
	return stamp;
}

function listOutputFiles(jobId: string): string[] {
	const dir = outputDir(jobId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

/** Save a run's output and prune to the newest OUTPUT_RETENTION files. Returns the file path. */
export async function saveJobOutput(jobId: string, content: string): Promise<string> {
	const dir = outputDir(jobId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${nextOutputStamp()}.md`);
	writeFileSync(file, content, "utf-8");
	const files = listOutputFiles(jobId);
	while (files.length > OUTPUT_RETENTION) {
		const oldest = files.shift();
		if (oldest) rmSync(join(dir, oldest), { force: true });
	}
	return file;
}

/** Content of the newest output file for a job, or null when none exists. */
export function getLatestJobOutput(jobId: string): string | null {
	const files = listOutputFiles(jobId);
	const latest = files[files.length - 1];
	if (!latest) return null;
	try {
		return readFileSync(join(outputDir(jobId), latest), "utf-8");
	} catch {
		return null;
	}
}
