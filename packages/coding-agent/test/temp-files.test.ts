import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { sweepStaleTempFiles } from "../src/core/temp-files.ts";

const roots: string[] = [];
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "lunr-temp-files-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("removes overflow logs when the process exits", () => {
	const dir = root();
	const log = join(dir, "lunr-bash-0123456789abcdef.log");
	const module = pathToFileURL(join(import.meta.dirname, "../src/core/temp-files.ts")).href;
	const script = `
		import { writeFileSync } from "node:fs";
		const { removeOnExit } = await import(${JSON.stringify(module)});
		writeFileSync(${JSON.stringify(log)}, "output");
		removeOnExit(${JSON.stringify(log)});
		process.exit(0);
	`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		encoding: "utf8",
		timeout: 15_000,
	});
	expect(result.status, result.stderr).toBe(0);
	expect(existsSync(log)).toBe(false);
});

it("sweeps lunR temp entries older than a day and keeps the rest", async () => {
	const dir = root();
	const now = Date.now();
	const old = new Date(now - 25 * 60 * 60 * 1000);
	for (const name of ["lunr-bash-0123456789abcdef.log", "lunr-bash-fedcba9876543210.log", "other.log"])
		writeFileSync(join(dir, name), "x");
	mkdirSync(join(dir, "lunr-claude-code-abc123"));
	writeFileSync(join(dir, "lunr-claude-code-abc123", "system.md"), "x");
	for (const name of ["lunr-bash-0123456789abcdef.log", "other.log", "lunr-claude-code-abc123"])
		utimesSync(join(dir, name), old, old);

	await sweepStaleTempFiles(dir, now);

	expect(readdirSync(dir).sort()).toEqual(["lunr-bash-fedcba9876543210.log", "other.log"]);
});
