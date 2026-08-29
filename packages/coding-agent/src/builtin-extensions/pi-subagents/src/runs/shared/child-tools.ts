// @ts-nocheck
/**
 * Central permission-to-tool resolver for prompt-driven children.
 *
 * Full access is the coding-tool set (read/search/shell/edit/write/web/LSP/MCP
 * plus output and supervisor coordination). It is not parent-equivalent: cron,
 * memory, behavior, goals, plan approval, nested subagent management, and other
 * persistent/user-config tools stay excluded.
 *
 * Read-only drops mutating coding tools from the registry and still runs under
 * Plan mode as defense in depth.
 */

import type { ChildPermission } from "../../../../../core/subagent-permission-inherit.ts";

/** Parent-owned / persistent tools excluded even from full children. */
export const PARENT_OWNED_CHILD_TOOLS = [
	"cron",
	"memory_add",
	"memory_remove",
	"memory_load",
	"behavior_add",
	"behavior_remove",
	"behavior_load",
	"present_plan",
	"goal_complete",
	"goal_blocked",
	"subagent",
	"subagent_wait",
] as const;

/** Mutating coding tools omitted from the read-only child registry. */
export const READ_ONLY_EXCLUDED_CHILD_TOOLS = [
	"edit",
	"write",
	"code_rewrite",
	"lsp_rename",
] as const;

const PARENT_OWNED_SET = new Set<string>(PARENT_OWNED_CHILD_TOOLS);
const READ_ONLY_SET = new Set<string>(READ_ONLY_EXCLUDED_CHILD_TOOLS);

export interface ResolveChildExcludeToolsInput {
	permissions: ChildPermission;
	/** Dynamic fanout children may keep the child-safe subagent tool. */
	fanoutAuthorized?: boolean;
}

export function resolveChildExcludeTools(input: ResolveChildExcludeToolsInput): string[] {
	const excluded = new Set<string>(PARENT_OWNED_SET);
	if (input.fanoutAuthorized) {
		excluded.delete("subagent");
	}
	if (input.permissions === "read-only") {
		for (const tool of READ_ONLY_SET) excluded.add(tool);
	}
	return [...excluded];
}

export function isParentOwnedChildTool(name: string): boolean {
	return PARENT_OWNED_SET.has(name);
}

export function isReadOnlyExcludedChildTool(name: string): boolean {
	return READ_ONLY_SET.has(name);
}
