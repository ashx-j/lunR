import type { ChildProcessByStdio } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/5303
 *
 * waitForChildProcess armed a fixed 100ms timer on `exit` and destroyed the
 * stdio streams when it fired. When a short-lived detached descendant kept the
 * stdout pipe open, `close` never fired, so that timer was the only thing that
 * resolved the wait, and any output written more than 100ms after exit was
 * binned. In practice every git commit whose pre-commit hook runs lint-staged
 * came back truncated mid-listr2 output, read by the model as a hang.
 *
 * The fix re-arms the grace on each chunk, so an actively writing pipe keeps us
 * reading while a genuinely idle held-open handle still releases after the
 * grace elapses. Both behaviours are covered below.
 */
describe.skipIf(process.platform === "win32")("issue #5303 bash output truncation past exit", () => {
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

	const ready = join(tmpdir(), `pi-5303-${process.pid}.ready`);

	afterEach(() => {
		rmSync(ready, { force: true });
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		child = undefined;
	});

	it("captures output emitted after exit while a detached child holds stdout open", async () => {
		// The shell exits as soon as a backgrounded node ticker is running. The ticker keeps the stdout
		// pipe open and writes every 40 ms, the last well past the 100 ms grace. One process for all
		// ticks: forking `sleep` per tick put the gaps past 100 ms on loaded macOS runners.
		const ticker = `require("fs").writeFileSync(${JSON.stringify(ready)}, ""); let i = 0; const t = setInterval(() => { process.stdout.write("TICK" + ++i + "\\n"); if (i === 8) clearInterval(t); }, 40);`;
		const command = `"${process.execPath}" -e '${ticker}' & until [ -e "${ready}" ]; do sleep 0.01; done; printf "HEAD\\n"`;
		child = spawnProcess("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const exitCode = await waitForChildProcess(child);

		expect(exitCode).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("TICK8");
	});

	it("resolves promptly when a detached child holds stdout open but stays quiet", async () => {
		// The shell exits, but a backgrounded sleeper inherits the stdout pipe and
		// keeps it open for a long time without writing. `close` never fires, so we
		// must still release via the idle grace rather than hang on the open handle.
		const command = 'printf "DONE\\n"; ( sleep 30 ) &';
		child = spawnProcess("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const start = Date.now();
		const exitCode = await waitForChildProcess(child);
		const elapsed = Date.now() - start;

		expect(exitCode).toBe(0);
		expect(output).toContain("DONE");
		// Must not wait for the 30s sleeper; the idle grace releases us in well under a second.
		expect(elapsed).toBeLessThan(2000);
	});
});
