#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Enable before importing the rest of the graph so subsequent processes can
// reuse V8 code cache. Helps the first start after a reboot when the OS page
// cache is cold. Static imports are hoisted, so main is loaded dynamically.
try {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".lunr", "agent");
	enableCompileCache(join(agentDir, "compile-cache"));
} catch {
	// Node < 22.8 or unwritable cache dir.
}

const [{ APP_NAME }, { configureHttpDispatcher }, { main }] = await Promise.all([
	import("./config.ts"),
	import("./core/http-dispatcher.ts"),
	import("./main.ts"),
]);

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

await main(process.argv.slice(2));
