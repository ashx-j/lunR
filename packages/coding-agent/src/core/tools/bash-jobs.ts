import { spawn } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai/compat";
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
	exit?: { code: number | null; signal: NodeJS.Signals | null };
	/** Set when bash_job or session end stopped the job, so its exit is not announced. */
	stopped: boolean;
	/** Set once the model has seen the exit, in a read or a notice. */
	exitReported: boolean;
}

/** Process groups of every running job in this process, stopped when lunR exits. */
const liveJobPids = new Set<number>();
let exitHookInstalled = false;
const signalHooks = new Map<NodeJS.Signals, () => void>();

function stopLiveJobs(): void {
	for (const pid of liveJobPids) killProcessTree(pid);
	liveJobPids.clear();
}

/**
 * Every mode reaches `exit`, so one hook covers TUI, print, RPC, ACP and subagent children.
 * A signal ends the process without `exit`, so a signal hook runs first, stops the jobs and
 * removes itself. Then the other listeners decide as before: `signal-exit` (from proper-lockfile)
 * re-raises only when its own listeners are all that is left. With no listener left, the hook
 * exits with the default action's code, because Node swallows a signal re-raised in its handler.
 * The next job start installs the hook again.
 */
function installProcessHooks(): void {
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", stopLiveJobs);
	}
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) {
		if (signalHooks.has(signal)) continue;
		const onSignal = () => {
			stopLiveJobs();
			process.off(signal, onSignal);
			signalHooks.delete(signal);
			if (process.listenerCount(signal) === 0) process.exit(128 + constants.signals[signal]);
		};
		signalHooks.set(signal, onSignal);
		process.prependListener(signal, onSignal);
	}
}

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
		this.logDir ??= mkdtempSync(join(tmpdir(), "lunr-jobs-"));
		const id = `j${this.nextId++}`;
		const logPath = join(this.logDir, `${id}.log`);
		const logFd = openSync(logPath, "a");
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
		const job: BashJob = { id, command, pid: child.pid, logPath, readOffset: 0, stopped: false, exitReported: false };
		this.jobs.set(id, job);
		if (child.pid) {
			installProcessHooks();
			liveJobPids.add(child.pid);
		}
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (job.exit) return;
			job.exit = { code, signal };
			if (job.pid) liveJobPids.delete(job.pid);
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
		return [...this.jobs.values()].filter((job) => !job.exit);
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
			if (dropped > 0) parts.push(`[${formatSize(dropped)} of earlier output left out. Full log: ${job.logPath}]`);
		} finally {
			closeSync(fd);
		}
		parts.push(`[${describeStatus(job)}]`);
		if (job.exit) job.exitReported = true;
		return parts.join("\n");
	}

	stop(job: BashJob): void {
		if (job.exit) return;
		job.stopped = true;
		if (job.pid) {
			killProcessTree(job.pid);
			liveJobPids.delete(job.pid);
		}
	}

	/** Called when the session ends: stops every job and removes the logs. */
	stopAll(): void {
		for (const job of this.jobs.values()) this.stop(job);
		this.unreported = [];
		if (this.logDir) rmSync(this.logDir, { recursive: true, force: true });
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
	} catch {}
}

function describeStatus(job: BashJob): string {
	if (!job.exit) return job.stopped ? "stopping" : "running";
	if (job.stopped) return "stopped";
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
				const wasRunning = !job.exit;
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

function groupAlive(pid: number): boolean {
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
		} catch {}
	});
}
