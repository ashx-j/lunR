#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InteractiveStartupShell } from "./startup/interactive-shell.ts";
import { resolvePreloadLaunchMode } from "./startup/launch-routing.ts";
import { markStartupMilestone } from "./startup/startup-milestones.ts";

markStartupMilestone("process_entry");
process.title = "lunr";
if (process.stdout.isTTY) {
	process.stdout.write("\x1b]0;lunr\x07");
}

try {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".lunr", "agent");
	enableCompileCache(join(agentDir, "compile-cache"));
} catch {}

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

let startupShell: InteractiveStartupShell | undefined;
if (preloadMode === "interactive") {
	const { InteractiveStartupShell } = await import("./startup/interactive-shell.ts");
	startupShell = new InteractiveStartupShell();
	startupShell.start();
	await startupShell.waitForFirstFrame();
	if (startupShell.isExitRequested) process.exit(0);
}

const importStarted = performance.now();
try {
	const [{ APP_NAME }, { main }, { noteImportMain }] = await Promise.all([
		import("./config.ts"),
		import("./main.ts"),
		import("./core/timings.ts"),
	]);
	noteImportMain(performance.now() - importStarted);
	process.title = APP_NAME;
	await main(args, { startupShell });
} catch (error) {
	if (startupShell && !startupShell.isExitRequested) {
		process.exitCode = 1;
		await startupShell.fail(error);
	} else {
		throw error;
	}
}
