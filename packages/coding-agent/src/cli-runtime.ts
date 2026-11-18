#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli/args.ts";
import { readPipedStdin, readsStdinBeforeTurn } from "./cli/piped-stdin.ts";
import { isNodeBundle } from "./config.ts";
import type { InteractiveView } from "./startup/interactive-view.ts";
import { resolvePreloadLaunchMode } from "./startup/launch-routing.ts";
import { markStartupMilestone } from "./startup/startup-milestones.ts";

markStartupMilestone("process_entry");
process.title = "lunr";
const ownsTitle = process.stdout.isTTY && parseArgs(process.argv.slice(2)).mode !== "acp";
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

if (!isNodeBundle) {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".lunr", "agent");
		enableCompileCache(join(agentDir, "compile-cache"));
	} catch {}
}

process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
const startupBenchmark = process.env.PI_STARTUP_BENCHMARK === "1";
const preloadMode = resolvePreloadLaunchMode(args, {
	stdinIsTTY: process.stdin.isTTY === true,
	stdoutIsTTY: process.stdout.isTTY === true,
	startupBenchmark,
});
markStartupMilestone("mode_routed");

// A prompt launch with piped stdin starts reading it here, before main.ts loads (about 500 ms),
// so the first-byte wait overlaps startup. Subcommands (a leading non-flag word) and launches
// that use stdin for something else keep main's own read.
const launchArgs = parseArgs(args);
const pipedStdin =
	!process.stdin.isTTY &&
	!startupBenchmark &&
	(args[0] === undefined || args[0].startsWith("-")) &&
	launchArgs.mode !== "rpc" &&
	launchArgs.mode !== "acp" &&
	!launchArgs.help &&
	!launchArgs.version &&
	launchArgs.listModels === undefined &&
	launchArgs.export === undefined &&
	!readsStdinBeforeTurn(launchArgs)
		? readPipedStdin()
		: undefined;

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
		await main(args, { startupView, pipedStdin });
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
