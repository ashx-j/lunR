#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli/args.ts";
import { isNodeBundle, VERSION } from "./config.ts";
import type { InteractiveView } from "./startup/interactive-view.ts";
import { resolvePreloadLaunchMode } from "./startup/launch-routing.ts";
import { markStartupMilestone } from "./startup/startup-milestones.ts";

markStartupMilestone("process_entry");
process.title = "lunr";
const args = process.argv.slice(2);
const parsedArgs = parseArgs(args);
const ownsTitle = process.stdout.isTTY && parsedArgs.mode !== "acp";
// Bound before print and json modes redirect process.stdout.write to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
// Push the terminal's current title onto the xterm title stack (CSI 22;0 t) before lunR's first
// title write; the exit handler below pops it. Terminals without the stack ignore both sequences.
if (ownsTitle) writeStdout("\x1b[22;0t\x1b]0;lunr\x07");

let startupView: InteractiveView | undefined;
// Exit handlers run after all other code, so the pop (CSI 23;0 t) follows the TUI stop and every
// title write. No exit handler may write a title after it.
process.once("exit", () => {
	startupView?.stop();
	if (!ownsTitle) return;
	try {
		writeStdout("\x1b[23;0t");
	} catch {}
});

// Answer --version without importing main.ts (about 500 ms). Subcommands and argument errors
// take main's path, so the output matches. --help stays there because it lists the flags of
// every loaded extension.
if (parsedArgs.version && parsedArgs.diagnostics.length === 0 && args[0]?.startsWith("-")) {
	console.log(VERSION);
	process.exit(0);
}

process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const startupBenchmark = process.env.PI_STARTUP_BENCHMARK === "1";
const preloadMode = resolvePreloadLaunchMode(args, {
	stdinIsTTY: process.stdin.isTTY === true,
	stdoutIsTTY: process.stdout.isTTY === true,
	startupBenchmark,
});
markStartupMilestone("mode_routed");

// The bundle uses the compile cache only for non-interactive launches. There it saves about
// 170 ms, but in interactive launches it delays the first request by about 60 ms. Node checks
// each entry against its source and Node version and recompiles on a mismatch, so a cache
// left by an older lunR is safe.
if (!isNodeBundle || preloadMode !== "interactive") {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".lunr", "agent");
		enableCompileCache(join(agentDir, "compile-cache"));
	} catch {}
}

if (preloadMode === "interactive") {
	const { InteractiveView } = await import("./startup/interactive-view.ts");
	startupView = new InteractiveView();
	startupView.start();
	await startupView.waitForFirstFrame();
	if (startupView.isExitRequested) process.exit(0);
}

const startRuntime = async () => {
	const importStarted = performance.now();
	try {
		const [{ APP_NAME }, { main }, { noteImportMain }] = await Promise.all([
			import("./config.ts"),
			import("./main.ts"),
			import("./core/timings.ts"),
		]);
		noteImportMain(performance.now() - importStarted);
		process.title = APP_NAME;
		await main(args, { startupView });
	} catch (error) {
		if (startupBenchmark) console.error(error);
		if (startupView && !startupView.isExitRequested) {
			process.exitCode = 1;
			await startupView.fail(error);
		} else {
			throw error;
		}
	}
};
if (startupView) {
	await Promise.race([startRuntime(), startupView.waitForExit()]);
	if (startupView.isExitRequested) process.exit(process.exitCode ?? 0);
} else {
	await startRuntime();
}
