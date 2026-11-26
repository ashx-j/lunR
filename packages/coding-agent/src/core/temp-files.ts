import { rmSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Files and directories lunR leaves in the OS temp dir: bash overflow logs and Claude Code request dirs. */
const LUNR_TEMP_NAME = /^(lunr-(bash|output)-[0-9a-f]+\.log|lunr-claude-code-.+)$/;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const removeAtExit = new Set<string>();
let exitHookArmed = false;

/**
 * Removes `path` (a file or a directory tree) when this process exits. Bash overflow logs use this because
 * the model is told their path and may read them later in the session, so they cannot go when the command
 * ends. Foreground subagent session dirs without a parent session use it for the same reason.
 */
export function removeOnExit(path: string): void {
	if (!exitHookArmed) {
		exitHookArmed = true;
		process.on("exit", () => {
			for (const item of removeAtExit) rmSync(item, { recursive: true, force: true });
		});
	}
	removeAtExit.add(path);
}

/**
 * Deletes lunR temp entries that a killed process (SIGKILL, SIGINT in print mode) never removed: those older
 * than a day, and Claude Code process dirs (`lunr-claude-code-<owner pid>-*`) whose owner is gone. Interactive
 * mode calls it once after startup; it never blocks and ignores errors.
 */
export async function sweepStaleTempFiles(dir: string = tmpdir(), now: number = Date.now()): Promise<void> {
	try {
		for (const name of await readdir(dir)) {
			if (!LUNR_TEMP_NAME.test(name)) continue;
			const path = join(dir, name);
			try {
				if (ownerGone(name) || now - (await stat(path)).mtimeMs > STALE_AFTER_MS)
					await rm(path, { recursive: true, force: true });
			} catch {
				// Another lunR may have removed it first.
			}
		}
	} catch {
		// An unreadable temp dir leaves nothing to sweep.
	}
}

/** Whether `name` is a Claude Code process dir whose owning lunR no longer runs. */
function ownerGone(name: string): boolean {
	const owner = Number(/^lunr-claude-code-(\d+)-/.exec(name)?.[1]);
	if (!owner || owner === process.pid) return false;
	try {
		process.kill(owner, 0);
		return false;
	} catch (error) {
		// EPERM: the pid belongs to another user's live process.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}
