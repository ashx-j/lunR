import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ClaudeCodeWorker = "lunr_bridge.py" | "lunr_setup_bridge.py";

/** External Python needs physical files, including when JavaScript lives in Bun's virtual filesystem. */
export function getClaudeCodeWorkerPath(
	worker: ClaudeCodeWorker,
	runtime = { moduleUrl: import.meta.url, execPath: process.execPath },
): string {
	const compiled = /\$bunfs|~BUN|%7EBUN/i.test(runtime.moduleUrl);
	const directory = compiled
		? join(dirname(runtime.execPath), "vendor", "hermes-claude-subscription-directsdk")
		: fileURLToPath(new URL("../../vendor/hermes-claude-subscription-directsdk/", runtime.moduleUrl));
	const path = join(directory, worker);
	if (!existsSync(path)) {
		throw new Error(
			"Claude Code subscription worker is missing. Reinstall the complete lunR package or extract the complete standalone archive.",
		);
	}
	return path;
}
