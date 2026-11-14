import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The first-paint TUI owns the screen before the runtime loads, so a raw console write shifts the
// screen under it and leaves a second boot header behind. Startup warnings must render inside the TUI.
it("shows every unmatched scoped-model warning inside the first-paint TUI", async () => {
	const root = mkdtempSync(join(tmpdir(), "lunr-scope-warning-"));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ enabledModels: ["missing/one", "missing/two"] }));
	const fakeTty = `for (const s of [process.stdout, process.stderr]) { s.isTTY = true; s.columns = 100; s.rows = 30; }
process.stdin.isTTY = true; process.stdin.setRawMode = function () { return this; };`;
	const cli = pathToFileURL(resolve(__dirname, "../src/cli.ts")).href;
	const args = ["--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session"];
	const environment: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
		if (process.env[key]) environment[key] = process.env[key]!;
	}
	Object.assign(environment, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" });
	const child = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs")).href,
			"--input-type=module",
			"-e",
			// An -e script has no script path in argv, so add one before the CLI reads argv.slice(2).
			`${fakeTty}\nprocess.argv.splice(1, Infinity, "lunr", ...${JSON.stringify(args)});\nawait import(${JSON.stringify(cli)});`,
		],
		{ cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exited = new Promise((done) => child.once("exit", done));
	const warnings = ['No models match pattern "missing/one"', 'No models match pattern "missing/two"'];
	try {
		const deadline = Date.now() + 45_000;
		while (
			!warnings.every((warning) => stdout.includes(warning) || stderr.includes(warning)) &&
			Date.now() < deadline
		) {
			await new Promise((wait) => setTimeout(wait, 50));
		}
		for (const warning of warnings) {
			expect(stderr).not.toContain(warning);
			expect(stdout).toContain(warning);
		}
	} finally {
		child.kill();
		await exited;
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}, 60_000);
