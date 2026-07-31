/**
 * lunR: session-scoped process tracking — in-memory registry of detached child
 * processes started via the bash tool.
 *
 * Tracks running processes so the user can see them (/processes), kill them,
 * and is prompted at quit time. Processes are tagged with the owning session id
 * so concurrent gateway chats do not share process visibility.
 *
 * pause/resume are Unix-only (SIGSTOP/SIGCONT); they throw on win32.
 * restart re-spawns the recorded command detached and registers the new pid.
 */

import { spawn } from "node:child_process";
import { getShellConfig, killProcessTree } from "../utils/shell.ts";

export interface TrackedProcess {
	pid: number;
	command: string;
	cwd: string;
	startedAt: number;
	status: "running" | "paused" | "exited";
	exitCode?: number;
	exitedAt?: number;
	/** Owning session id (gateway chats use this for isolation). */
	sessionId?: string;
}

const isWin32 = process.platform === "win32";

/** Only retain exited processes that ran longer than this (ms). */
const EXIT_NOISE_GATE_MS = 3000;
/** Evict exited entries after this TTL (ms). */
const EXIT_TTL_MS = 5 * 60 * 1000;
/** Hard cap on tracked entries to prevent unbounded growth. */
const MAX_TRACKED = 100;

const processes = new Map<number, TrackedProcess>();

export function register(pid: number, command: string, cwd: string, sessionId?: string): void {
	if (!pid) return;
	// Evict the oldest non-busy entry when over cap. Exited entries are preferred
	// for eviction; if none, evict the oldest running entry.
	if (processes.size >= MAX_TRACKED) {
		let oldest: { pid: number; entry: TrackedProcess } | undefined;
		for (const [p, entry] of processes) {
			if (entry.status === "exited") {
				oldest = { pid: p, entry };
				break;
			}
			if (!oldest || entry.startedAt < oldest.entry.startedAt) {
				oldest = { pid: p, entry };
			}
		}
		if (oldest) processes.delete(oldest.pid);
	}
	processes.set(pid, { pid, command, cwd, startedAt: Date.now(), status: "running", sessionId });
}

export function unregister(pid: number): void {
	if (!pid) return;
	processes.delete(pid);
}

/**
 * Mark a tracked process as exited. Short-lived processes (< 3s) are deleted
 * immediately to avoid noise; longer ones are retained as "exited" for 5 minutes.
 */
export function markExited(pid: number, exitCode: number | null): void {
	if (!pid) return;
	const entry = processes.get(pid);
	if (!entry) return;
	const livedMs = Date.now() - entry.startedAt;
	if (livedMs < EXIT_NOISE_GATE_MS) {
		processes.delete(pid);
		return;
	}
	entry.status = "exited";
	entry.exitCode = exitCode ?? undefined;
	entry.exitedAt = Date.now();
}

/** Returns the list, pruning dead entries via a liveness probe. */
export function list(sessionId?: string): TrackedProcess[] {
	prune();
	return [...processes.values()].filter((p) => sessionId === undefined || p.sessionId === sessionId);
}

function prune(): void {
	for (const [pid, entry] of processes) {
		if (entry.status === "exited") {
			if (!entry.exitedAt || Date.now() - entry.exitedAt > EXIT_TTL_MS) {
				processes.delete(pid);
			}
			continue;
		}
		if (!isAlive(pid)) {
			// A running/paused process that died unexpectedly becomes exited so
			// the user can see it, then the TTL evicts it.
			markExited(pid, null);
		}
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function kill(pid: number): void {
	if (!processes.has(pid)) return;
	killProcessTree(pid);
	processes.delete(pid);
}

export function killAll(sessionId?: string): void {
	for (const [pid, entry] of processes) {
		if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
		try {
			killProcessTree(pid);
		} catch {
			// ignore
		}
		processes.delete(pid);
	}
}

export function pause(pid: number): void {
	if (isWin32) throw new Error("Pause/resume is unsupported on Windows.");
	if (!processes.has(pid)) throw new Error(`Process ${pid} is not tracked.`);
	try {
		process.kill(pid, "SIGSTOP");
		const entry = processes.get(pid);
		if (entry) entry.status = "paused";
	} catch {
		// process may have died
		processes.delete(pid);
	}
}

export function resume(pid: number): void {
	if (isWin32) throw new Error("Pause/resume is unsupported on Windows.");
	if (!processes.has(pid)) throw new Error(`Process ${pid} is not tracked.`);
	try {
		process.kill(pid, "SIGCONT");
		const entry = processes.get(pid);
		if (entry) entry.status = "running";
	} catch {
		processes.delete(pid);
	}
}

export function restart(pid: number): number | undefined {
	const entry = processes.get(pid);
	if (!entry) return undefined;
	try {
		killProcessTree(pid);
	} catch {
		// ignore
	}
	processes.delete(pid);

	try {
		const shellConfig = getShellConfig();
		const child = spawn(shellConfig.shell, [...shellConfig.args, entry.command], {
			cwd: entry.cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		if (child.pid) {
			register(child.pid, entry.command, entry.cwd, entry.sessionId);
			child.unref();
			return child.pid;
		}
	} catch {
		// re-spawn failed
	}
	return undefined;
}

export function isWindows(): boolean {
	return isWin32;
}

/** Clear the registry (called on session replace). Pass sessionId to clear only one session's entries. */
export function clearRegistry(sessionId?: string): void {
	if (sessionId === undefined) {
		processes.clear();
		return;
	}
	for (const [pid, entry] of processes) {
		if (entry.sessionId === sessionId) processes.delete(pid);
	}
}
