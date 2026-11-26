// TEMPORARY diagnostic for Windows CI, removed before merge.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";

it.skipIf(process.platform !== "win32")("DIAG bash output into an fd opened with a and w", () => {
	const dir = mkdtempSync(join(tmpdir(), "diag-"));
	const shell = getShellConfig();
	const results = (["a", "w", "a+"] as const).map((flag) => {
		const path = join(dir, `${flag.replace("+", "p")}.log`);
		const fd = openSync(path, flag);
		const run = spawnSync(shell.shell, [...shell.args, "echo hi; sleep 0.1 & echo bg"], {
			stdio: ["ignore", fd, fd],
			windowsHide: true,
		});
		closeSync(fd);
		return { flag, status: run.status, error: run.error?.message, log: readFileSync(path, "utf-8") };
	});
	expect(JSON.stringify({ shell, results })).toBe("DIAG");
});
