/**
 * lunR: session process tracking — in-memory registry of detached child
 * processes started via the bash tool.
 *
 * Tracks running processes so the user can see them (/processes), kill them,
 * and is prompted at quit time. Module-level singleton (one session at a time);
 * cleared on session replace.
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
	status: "running" | "paused";
}

const isWin32 = process.platform === "win32";

const processes = new Map<number, TrackedProcess>();

export function register(pid: number, command: string, cwd: string): void {
	if (!pid) return;
	processes.set(pid, { pid, command, cwd, startedAt: Date.now(), status: "running" });
}

export function unregister(pid: number): void {
	if (!pid) return;
	processes.delete(pid);
}

/** Returns the list, pruning dead entries via a liveness probe. */
export function list(): TrackedProcess[] {
	prune();
	return [...processes.values()];
}

function prune(): void {
	for (const [pid] of processes) {
		if (!isAlive(pid)) {
			processes.delete(pid);
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

export function killAll(): void {
	for (const [pid] of processes) {
		try {
			killProcessTree(pid);
		} catch {
			// ignore
		}
	}
	processes.clear();
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
			register(child.pid, entry.command, entry.cwd);
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

/** Clear the registry (called on session replace). */
export function clearRegistry(): void {
	processes.clear();
}
