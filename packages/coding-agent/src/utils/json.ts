import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/**
 * Write `data` as pretty JSON through `<path>.tmp-<pid>` and a rename, creating the parent
 * directory first. `mode` is applied to the final file best-effort (Windows ACLs do not map).
 * Used by the install layout file; auth files use `writeAuthFileAtomic`.
 */
export function writeJsonFileAtomic(path: string, data: unknown, mode?: number): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
	if (mode === undefined) return;
	try {
		chmodSync(path, mode);
	} catch {
		// best-effort
	}
}
