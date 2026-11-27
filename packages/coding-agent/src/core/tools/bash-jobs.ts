import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	fstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import onExit from "signal-exit";
import { type Static, Type } from "typebox";
import { getShellConfig, killProcessTree } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

export interface BashJob {
	id: string;
	command: string;
	pid: number | undefined;
	logPath: string;
	/** Log bytes the model has already read. */
	readOffset: number;
	/** The shell's exit. Processes it started with `&` can outlive it, see childrenRunning. */
	exit?: { code: number | null; signal: NodeJS.Signals | null };
	/** The shell exited but its process group still has members, so the job still runs. */
	childrenRunning: boolean;
	/** Set when bash_job or session end stopped the job, so its exit is not announced. */
	stopped: boolean;
	/** Set once the model has seen the exit, in a read or a notice. */
	exitReported: boolean;
}

/** Every running job in this process, stopped when lunR exits. */
const liveJobs = new Set<BashJob>();
/** Log dirs of every session in this process, removed when lunR exits. */
const liveLogDirs = new Set<string>();
let exitHookInstalled = false;
const LOG_DIR_PREFIX = "lunr-jobs-";
/** Orphaned log dirs changed more recently than this stay, see removeOrphanedLogDirs. */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Kills the job's process group. Once the shell has exited its pid can belong to another process, so only
 * the group is signalled then, and only while it still has a member (a live member keeps the id reserved).
 */
function killJob(job: BashJob): void {
	if (!job.pid) return;
	if (!job.exit) {
		killProcessTree(job.pid);
		return;
	}
	if (!groupAlive(job.pid)) return;
	try {
		process.kill(-job.pid, "SIGKILL");
	} catch {
		// The group exited between the liveness check and the signal.
	}
}

/** The exit hook. Exported for tests. */
export function stopLiveJobs(): void {
	for (const job of liveJobs) killJob(job);
	liveJobs.clear();
	for (const dir of liveLogDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Exit cleanup: a log dir that cannot be removed stays for the next sweep.
		}
	}
	liveLogDirs.clear();
}

/** How often jobs whose shell exited are checked, so lunR learns soon when their last process ends. */
const GROUP_CHECK_MS = 2000;
let groupCheck: NodeJS.Timeout | undefined;

/** Drops jobs whose process group emptied, which ends their entry before the group id can be reused. */
function watchExitedGroups(): void {
	if (groupCheck) return;
	groupCheck = setInterval(() => {
		let waiting = false;
		for (const job of liveJobs) if (job.exit && isRunning(job)) waiting = true;
		if (!waiting) {
			clearInterval(groupCheck);
			groupCheck = undefined;
		}
	}, GROUP_CHECK_MS);
	groupCheck.unref();
}

/**
 * Every mode reaches `exit`, so one hook covers TUI, print, RPC, ACP and subagent children.
 * signal-exit also runs it for a signal that ends lunR, but not for one a listener keeps lunR
 * alive through (the SIGINT guard while the TUI is suspended, the gateway's restart).
 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", stopLiveJobs);
	onExit(stopLiveJobs);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Log dirs carry their lunR pid. A lunR killed with SIGKILL leaves its dir, so the first job of
 * a later lunR removes the dirs whose lunR is gone and whose logs sat untouched for a day. Their job
 * processes cannot be stopped safely, because the pids may belong to other processes by now.
 */
function removeOrphanedLogDirs(): void {
	let names: string[];
	try {
		names = readdirSync(tmpdir());
	} catch {
		return;
	}
	const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
	for (const name of names) {
		if (!name.startsWith(LOG_DIR_PREFIX)) continue;
		const pid = Number.parseInt(name.slice(LOG_DIR_PREFIX.length), 10);
		if (!(pid > 0) || pid === process.pid || pidAlive(pid)) continue;
		const dir = join(tmpdir(), name);
		try {
			// A lunR in another pid namespace sharing /tmp looks dead, but its jobs keep writing their logs.
			const changed = [dir, ...readdirSync(dir).map((log) => join(dir, log))].map((path) => statSync(path).mtimeMs);
			if (Math.max(...changed) > cutoff) continue;
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Another lunR removed or is writing this dir; try again next sweep.
		}
	}
}
let orphanedLogDirsRemoved = false;

/**
 * Background jobs the bash tool starts with `run_in_background`, owned by one session.
 * Output goes straight from the shell to a log file, so a chatty job costs lunR nothing until it is read.
 */
export class BashJobs {
	private readonly jobs = new Map<string, BashJob>();
	private readonly listeners = new Set<() => void>();
	private nextId = 1;
	private logDir: string | undefined;
	/** Exits the model has not seen yet. The session takes them with takeExitNotices(). */
	private unreported: BashJob[] = [];

	start(command: string, cwd: string, env: NodeJS.ProcessEnv, shellPath?: string): BashJob {
		const shellConfig = getShellConfig(shellPath);
		if (!this.logDir) {
			if (!orphanedLogDirsRemoved) {
				orphanedLogDirsRemoved = true;
				removeOrphanedLogDirs();
			}
			installExitHook();
			this.logDir = mkdtempSync(join(tmpdir(), `${LOG_DIR_PREFIX}${process.pid}-`));
			liveLogDirs.add(this.logDir);
		}
		const id = `j${this.nextId++}`;
		const logPath = join(this.logDir, `${id}.log`);
		// Git Bash cannot write to an append-only Windows handle ("a" opens one): echo fails and the
		// log stays empty. The log is new, so "w" writes the same bytes there.
		const logFd = openSync(logPath, process.platform === "win32" ? "w" : "a");
		const commandFromStdin = shellConfig.commandTransport === "stdin";
		const child = (() => {
			try {
				return spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
					cwd,
					detached: process.platform !== "win32",
					env,
					stdio: [commandFromStdin ? "pipe" : "ignore", logFd, logFd],
					windowsHide: true,
				});
			} finally {
				closeSync(logFd);
			}
		})();
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		// A job never keeps lunR alive; the exit hook stops it instead.
		child.unref();
		const job: BashJob = {
			id,
			command,
			pid: child.pid,
			logPath,
			readOffset: 0,
			childrenRunning: false,
			stopped: false,
			exitReported: false,
		};
		this.jobs.set(id, job);
		if (child.pid) liveJobs.add(job);
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (job.exit) return;
			job.exit = { code, signal };
			// The job runs in its own process group, so `cmd &` children keep it alive and in reach of stop.
			job.childrenRunning = !job.stopped && job.pid !== undefined && groupAlive(job.pid);
			if (job.childrenRunning) watchExitedGroups();
			else liveJobs.delete(job);
			if (!job.stopped) this.unreported.push(job);
			this.emitChange();
		};
		child.once("exit", finish);
		child.once("error", (error) => {
			appendLog(logPath, `${error.message}\n`);
			finish(null, null);
		});
		this.emitChange();
		return job;
	}

	get(id: string): BashJob | undefined {
		return this.jobs.get(id);
	}

	running(): BashJob[] {
		return [...this.jobs.values()].filter((job) => isRunning(job));
	}

	/** New output since the last read, capped like bash output. Says how much it left out. */
	read(job: BashJob): string {
		const parts: string[] = [];
		const fd = openSync(job.logPath, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(job.readOffset, size - DEFAULT_MAX_BYTES);
			const skipped = start - job.readOffset;
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			job.readOffset = size;
			const truncation = truncateTail(buffer.toString("utf-8"), { maxLines: DEFAULT_MAX_LINES });
			const dropped = skipped + truncation.totalBytes - truncation.outputBytes;
			parts.push(truncation.content.replace(/\n$/, "") || "(no new output)");
			if (dropped > 0) {
				parts.push(
					`[${formatSize(dropped)} of earlier output left out. Full log, deleted when the session ends: ${job.logPath}]`,
				);
			}
		} finally {
			closeSync(fd);
		}
		parts.push(`[${describeStatus(job)}]`);
		if (job.exit && !job.childrenRunning) job.exitReported = true;
		return parts.join("\n");
	}

	/** Stops the job's whole process group, also after its shell exited. */
	stop(job: BashJob): void {
		if (!isRunning(job)) return;
		job.stopped = true;
		job.childrenRunning = false;
		killJob(job);
		liveJobs.delete(job);
	}

	/** Called when the session ends: stops every job and removes the logs. */
	stopAll(): void {
		for (const job of this.jobs.values()) this.stop(job);
		this.unreported = [];
		if (this.logDir) {
			rmSync(this.logDir, { recursive: true, force: true });
			liveLogDirs.delete(this.logDir);
		}
		this.logDir = undefined;
		this.jobs.clear();
		this.emitChange();
	}

	/** One line per job that exited on its own since the last call and that no read has reported. */
	takeExitNotices(): string | undefined {
		const lines = this.unreported
			.filter((job) => !job.exitReported)
			.map((job) => {
				job.exitReported = true;
				return `[Background job ${job.id} ${describeStatus(job)}: ${firstLine(job.command)}]`;
			});
		this.unreported = [];
		return lines.length > 0 ? lines.join("\n") : undefined;
	}

	/** Listen for jobs starting and ending. Returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emitChange(): void {
		for (const listener of this.listeners) listener();
	}
}

function appendLog(path: string, text: string): void {
	try {
		appendFileSync(path, text);
	} catch {
		// The log dir is gone (session cleanup), so the spawn error has nowhere to go.
	}
}

/** Whether the job still runs. Clears childrenRunning once the exited shell's group is gone. */
function isRunning(job: BashJob): boolean {
	if (job.stopped) return false;
	if (!job.exit) return true;
	if (job.childrenRunning && job.pid !== undefined && !groupAlive(job.pid)) {
		job.childrenRunning = false;
		liveJobs.delete(job);
	}
	return job.childrenRunning;
}

function describeStatus(job: BashJob): string {
	if (!job.exit) return job.stopped ? "stopping" : "running";
	if (job.stopped) return "stopped";
	if (isRunning(job)) {
		return `shell exited with code ${job.exit.code}, but processes it started are still running (bash_job stop ends them)`;
	}
	if (job.exit.code !== null) return `exited with code ${job.exit.code}`;
	return job.exit.signal ? `was killed by ${job.exit.signal}` : "ended without an exit code";
}

function firstLine(command: string): string {
	const line = command.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 80)} …` : line;
}

const bashJobSchema = Type.Object({
	id: Type.String({ description: "Job id from bash" }),
	action: Type.Optional(StringEnum(["read", "stop"] as const, { description: "Default read" })),
});

export type BashJobToolInput = Static<typeof bashJobSchema>;

/** The model's way to read and stop the jobs that `bash` starts with `run_in_background`. */
export function createBashJobToolDefinition(jobs: BashJobs): ToolDefinition<typeof bashJobSchema, undefined> {
	return {
		name: "bash_job",
		label: "bash_job",
		description: "Read a background bash job's new output and exit status, or stop it.",
		parameters: bashJobSchema,
		async execute(_toolCallId, { id, action }) {
			const job = jobs.get(id);
			if (!job) {
				const known = jobs.running().map((entry) => entry.id);
				throw new Error(`No job ${id}. Running jobs: ${known.length > 0 ? known.join(", ") : "none"}`);
			}
			if (action === "stop") {
				const wasRunning = jobs.running().includes(job);
				jobs.stop(job);
				job.exitReported = true;
				return {
					content: [
						{
							type: "text",
							text: wasRunning ? `Stopped job ${id}.` : `Job ${id} had already ${describeStatus(job)}.`,
						},
					],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: jobs.read(job) }], details: undefined };
		},
	};
}

/** Process groups that foreground calls left running with `&`, listed when lunR exits. */
const leftovers = new Map<number, string>();
const MAX_LEFTOVERS = 50;
let leftoverHookInstalled = false;

/** Always false on Windows, which has no process groups; there a job ends with its shell. */
function groupAlive(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Called after a foreground call's shell exits. Processes it started with `&` keep its process
 * group alive and outlive lunR on purpose (dev servers); this only remembers them for the exit list.
 */
export function noteLeftoverProcesses(pid: number, command: string): void {
	if (process.platform === "win32" || !groupAlive(pid)) return;
	if (leftovers.size >= MAX_LEFTOVERS) {
		const oldest = leftovers.keys().next().value;
		if (oldest !== undefined) leftovers.delete(oldest);
	}
	leftovers.set(pid, command);
	if (leftoverHookInstalled) return;
	leftoverHookInstalled = true;
	process.once("exit", () => {
		const alive = [...leftovers].filter(([groupPid]) => groupAlive(groupPid));
		if (alive.length === 0) return;
		const lines = alive.map(([groupPid, cmd]) => `  ${firstLine(cmd)}  (kill -- -${groupPid})`);
		try {
			writeSync(2, `lunr: processes these commands started with & are still running:\n${lines.join("\n")}\n`);
		} catch {
			// stderr is closed at exit; the leftover note is informational.
		}
	});
}
