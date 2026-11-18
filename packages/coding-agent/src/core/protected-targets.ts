import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export const LUNR_MANAGED_STATE_WRITE_BLOCK_REASON =
	"This is gateway, MCP login or Claude Code state that lunR manages itself. The agent cannot change it.";

/** Windows and macOS (APFS, HFS+) are case-insensitive by default, so `SETTINGS.JSON` is settings.json there. */
function normalize(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * `canonicalizeTargetPath`, recomputed on every check because `git checkout`, an unpacked archive or
 * another terminal can turn any component into a symlink. The target and the policies share most
 * ancestors, so `memo` keeps one result per path for one check: one `lstat` per ancestor, and a full
 * resolve only for a component that is a symlink.
 */
function canonicalPath(path: string, memo: Map<string, string>): string {
	let canonical = memo.get(path);
	if (canonical !== undefined) return canonical;
	const parent = dirname(path);
	if (parent === path) canonical = path;
	else if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) canonical = canonicalizeTargetPath(path);
	else canonical = join(canonicalPath(parent, memo), basename(path));
	memo.set(path, canonical);
	return canonical;
}

function isWithin(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Shared direct-mutation policy. Check the requested name and its canonical destination. */
export function protectedTargetWriteReason(path: string, cwd: string): string | undefined {
	try {
		const memo = new Map<string, string>();
		const target = resolve(resolveToCwd(path, cwd));
		const targets = [normalize(target), normalize(canonicalPath(target, memo))];
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
			// Bot tokens, approved gateway users, MCP OAuth tokens and the pinned binary the Claude bridge runs.
			{ path: join(agentDir, "gateway.json"), reason: LUNR_MANAGED_STATE_WRITE_BLOCK_REASON },
			{ path: join(agentDir, "pairing"), tree: true, reason: LUNR_MANAGED_STATE_WRITE_BLOCK_REASON },
			{ path: join(agentDir, "mcp-oauth"), tree: true, reason: LUNR_MANAGED_STATE_WRITE_BLOCK_REASON },
			{ path: join(agentDir, "claude-code"), tree: true, reason: LUNR_MANAGED_STATE_WRITE_BLOCK_REASON },
		];
		for (const policy of policies) {
			const root = resolve(policy.path);
			const roots = [normalize(root), normalize(canonicalPath(root, memo))];
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
