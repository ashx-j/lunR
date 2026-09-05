// Exercises the built CLI and real TUI with runtime hydration held indefinitely.
// Run after the offline package builds: node scripts/check-interactive-first-paint.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages/coding-agent/dist/cli.js");

async function check(fail) {
	const agentDir = mkdtempSync(join(tmpdir(), "lunr-paint-check-"));
	const fixture = `export async function main() {
process.stderr.write("FIXTURE_RUNTIME_WAIT\\n");
${fail ? 'await new Promise(r => setTimeout(r, 200)); throw new Error("fixture hydration failure");' : 'await new Promise(() => {});'}
}`;
	const preload = `import { registerHooks } from "node:module";
registerHooks({ load(url, context, nextLoad) {
 if (url.endsWith("/coding-agent/dist/main.js")) return { format: "module", shortCircuit: true, source: ${JSON.stringify(fixture)} };
 return nextLoad(url, context);
}});`;
	const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli], {
		cwd: agentDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_STARTUP_BENCHMARK: "1", PI_TIMING: "1", PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let exited = false;
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	const exit = new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => { exited = true; resolveExit(code); });
	});
	const waitFor = async (predicate) => {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (exited || Date.now() >= deadline) throw new Error(`Startup check did not reach its expected state: ${stderr}`);
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	};
	try {
		await waitFor(() => stderr.includes("FIXTURE_RUNTIME_WAIT"));
		await waitFor(() => stdout.includes("╰"));
		assert(stdout.includes("> "));
		assert(!stdout.includes("Starting lunR"));
		assert(stderr.indexOf('"first_frame_committed"') < stderr.indexOf("FIXTURE_RUNTIME_WAIT"));
		assert(!stderr.includes('"runtime_hydrated"'));
		if (fail) {
			assert.equal(await exit, 1);
		} else {
			child.stdin.write("draft");
			await waitFor(() => stdout.includes("draft"));
			child.stdin.write("\x03\x03");
			await waitFor(() => exited);
			assert.equal(await exit, 0);
		}
		assert.equal(stdout.split("\x1b[?1049h").length - 1, 1);
		assert(stdout.includes("\x1b[?1049l"), "terminal must be restored on exit");
		console.log(`${fail ? "failed" : "stalled"} runtime: real frame before hydration, terminal restored`);
	} finally {
		if (!exited) { child.kill(); await exit; }
		rmSync(agentDir, { recursive: true, force: true });
	}
}

await check(false);
await check(true);
