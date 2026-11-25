import { mkdirSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

// `mkdir -p` for paths that come from the model. Node's `{ recursive: true }` retries
// forever when a directory answers ENOENT although its parent exists (any new name
// under /proc), and that loop runs in the libuv pool, so the process cannot even exit.
// Here a second ENOENT after the parent exists is final.

/** Creates `dir` and its missing parents, or rejects with the system's error. */
export async function mkdirParents(dir: string, parentExists = false): Promise<void> {
	try {
		await mkdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" && (await stat(dir)).isDirectory()) return;
		const parent = dirname(dir);
		if (code !== "ENOENT" || parentExists || parent === dir) throw error;
		await mkdirParents(parent);
		await mkdirParents(dir, true);
	}
}

/** Synchronous `mkdirParents`. */
export function mkdirParentsSync(dir: string, parentExists = false): void {
	try {
		mkdirSync(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" && statSync(dir).isDirectory()) return;
		const parent = dirname(dir);
		if (code !== "ENOENT" || parentExists || parent === dir) throw error;
		mkdirParentsSync(parent);
		mkdirParentsSync(dir, true);
	}
}
