import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { canonicalizeTargetPath } from "../utils/paths.ts";
import { getInstructionsRoot } from "./model-instructions.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export const GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON =
	"The agents instruction tree is user-managed. The agent cannot change ~/.lunr/agent/agents/.";
export const MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON =
	"Memory is model-managed through the memory tools. Do not directly change ~/.lunr/simple-memory/memory.md.";
export const SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON =
	"lunR settings are user-managed through /settings. Do not directly change settings.json.";
export const PR_WATCH_STATE_WRITE_BLOCK_REASON =
	"PR watch state is client-managed. Use pr_watch start/wait; only the user can cancel or restart through /pr-watch.";

function normalize(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Shared direct-mutation policy. Check the requested name and its canonical destination. */
export function protectedTargetWriteReason(path: string, cwd: string): string | undefined {
	try {
		const target = resolveToCwd(path, cwd);
		const targets = [normalize(target), normalize(canonicalizeTargetPath(target))];
		const agentDir = getAgentDir();
		const policies = [
			{ path: getInstructionsRoot(agentDir), tree: true, reason: GLOBAL_AGENTS_FILE_WRITE_BLOCK_REASON },
			{ path: join(dirname(agentDir), "simple-memory", "memory.md"), reason: MEMORY_FILE_DIRECT_WRITE_BLOCK_REASON },
			{ path: join(agentDir, "settings.json"), reason: SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON },
			{ path: join(agentDir, "pr-watches"), tree: true, reason: PR_WATCH_STATE_WRITE_BLOCK_REASON },
			{ path: join(cwd, CONFIG_DIR_NAME, "settings.json"), reason: SETTINGS_FILE_DIRECT_WRITE_BLOCK_REASON },
			{
				path: join(agentDir, "install-features.json"),
				reason:
					"Optional features are user-managed through lunr features; Browser is managed in /settings. Do not change install-features.json directly.",
			},
		];
		for (const policy of policies) {
			const roots = [normalize(policy.path), normalize(canonicalizeTargetPath(policy.path))];
			if (
				targets.some((candidate) =>
					roots.some((root) => (policy.tree ? isWithin(candidate, root) : candidate === root)),
				)
			) {
				return policy.reason;
			}
		}
	} catch (error) {
		return `Cannot validate mutation target: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}
