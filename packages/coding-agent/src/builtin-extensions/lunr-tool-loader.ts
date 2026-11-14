/**
 * lunr-tool-loader — start rarely used tools unloaded and load them on demand.
 *
 * lunR: this file is lunR-native (not an absorbed upstream extension).
 *
 *  - At the first prompt of each session, when the model loads tools natively (`supportsDeferredToolLoading`),
 *    the tools in DEFERRED_TOOL_GROUPS leave the active set through `pi.setDeferredTools` and `load_tools` is
 *    registered. Its description is the catalog and is never rebuilt inside the session, so the request
 *    prefix stays fixed.
 *  - `load_tools` activates whole groups with `pi.setActiveTools`. The tool wrapper records the activation
 *    as `addedToolNames` on the result, which providers turn into their native load point.
 *  - On resume or fork, groups the branch already loaded or called start active.
 *
 * Runtime imports stay on concrete core modules — never the package barrel.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { supportsDeferredToolLoading } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

/**
 * The only list of deferred tools. A group loads as a whole; a tool not named here stays loaded.
 * `blurb` follows a tool in the catalog, and a group's `blurb` follows its whole tool list.
 */
export const DEFERRED_TOOL_GROUPS: ReadonlyArray<{
	name: string;
	blurb?: string;
	tools: ReadonlyArray<{ name: string; blurb?: string }>;
}> = [
	{
		name: "subagents",
		tools: [
			{ name: "subagent", blurb: "delegate work to child agents, run chains, check status" },
			{ name: "subagent_wait", blurb: "block until background children change" },
		],
	},
	{
		name: "web",
		tools: [
			{ name: "web_search", blurb: "search the web" },
			{ name: "fetch_content", blurb: "read URLs as markdown" },
			{ name: "get_search_content", blurb: "page through stored web results" },
		],
	},
	{
		name: "lsp",
		blurb: "language server queries",
		tools: [
			{ name: "lsp_diagnostics" },
			{ name: "lsp_hover" },
			{ name: "lsp_definition" },
			{ name: "lsp_references" },
			{ name: "lsp_symbols" },
			{ name: "lsp_rename" },
			{ name: "lsp_code_actions" },
			{ name: "lsp_completions" },
		],
	},
	{ name: "browser", tools: [{ name: "browser", blurb: "headless Chromium for JavaScript pages and site interaction" }] },
	{ name: "code_rewrite", tools: [{ name: "code_rewrite", blurb: "structural find and replace with AST patterns" }] },
	{ name: "cron", tools: [{ name: "cron", blurb: "schedule and manage unattended prompts" }] },
	{ name: "pr_watch", tools: [{ name: "pr_watch", blurb: "watch a GitHub pull request for reviews and checks" }] },
];

const LOADER_INTRO =
	"Load tools that exist but are not loaded yet. The tools listed below have no schema in this conversation until you load them, so calling one directly fails. Call load_tools with the tool or group names you need, then call the tools in your next step. Loading is permanent for the session; load only what the task needs.";

type Group = { name: string; blurb?: string; tools: Array<{ name: string; blurb?: string }> };

/** The table narrowed to the tools this session deferred, without groups that lost every tool. */
function acceptedGroups(accepted: ReadonlySet<string>): Group[] {
	return DEFERRED_TOOL_GROUPS.flatMap((group) => {
		const tools = group.tools.filter((tool) => accepted.has(tool.name));
		return tools.length ? [{ ...group, tools }] : [];
	});
}

/** The `load_tools` description: the intro, then one catalog line per group. */
export function loaderDescription(groups: readonly Group[]): string {
	const lines = groups.map((group) => {
		const tools = group.tools.map((tool) => (tool.blurb ? `${tool.name} (${tool.blurb})` : tool.name)).join(", ");
		return `- ${group.name}: ${tools}${group.blurb ? ` (${group.blurb})` : ""}`;
	});
	return `${LOADER_INTRO}\n\nGroups and tools:\n${lines.join("\n")}`;
}

/** Tool names of every group that a requested group or tool name belongs to. Unknown names come back separately. */
function resolve(groups: readonly Group[], names: readonly string[]): { tools: string[]; unknown: string[] } {
	const tools: string[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const group = groups.find((g) => g.name === name || g.tools.some((tool) => tool.name === name));
		if (group) tools.push(...group.tools.map((tool) => tool.name));
		else unknown.push(name);
	}
	return { tools: [...new Set(tools)], unknown };
}

/** Deferred tools the branch already used: loaded by a result or called by the model, before compaction too. */
function usedOnBranch(ctx: ExtensionContext, accepted: ReadonlySet<string>): string[] {
	const used = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) if (accepted.has(name)) used.add(name);
		} else if (message.role === "assistant") {
			for (const block of message.content)
				if (block.type === "toolCall" && accepted.has(block.name)) used.add(block.name);
		}
	}
	return [...used];
}

export default function toolLoader(pi: ExtensionAPI): void {
	let state: "undecided" | "on" | "off" = "undecided";

	pi.on("session_start", () => {
		state = "undecided";
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (state !== "undecided") return;
		state = "off";
		if (!ctx.model || !supportsDeferredToolLoading(ctx.model)) return;
		const accepted = new Set(
			pi.setDeferredTools(DEFERRED_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => tool.name))),
		);
		if (!accepted.size) return;
		const groups = acceptedGroups(accepted);
		const validNames = groups.flatMap((group) => [group.name, ...group.tools.map((tool) => tool.name)]);

		pi.registerTool({
			name: "load_tools",
			label: "Load tools",
			description: loaderDescription(groups),
			parameters: Type.Object({
				names: Type.Array(Type.String(), {
					description: "Tool or group names from the list in this tool's description.",
				}),
			}),
			async execute(_toolCallId, params) {
				const { tools, unknown } = resolve(groups, params.names);
				if (!tools.length)
					throw new Error(`Unknown names: ${unknown.join(", ") || "none given"}. Valid names: ${validNames.join(", ")}.`);
				const active = pi.getActiveTools();
				const loaded = tools.filter((name) => !active.includes(name));
				pi.setActiveTools([...active, ...loaded]);
				const lines = [
					...(loaded.length ? [`Loaded tools: ${loaded.join(", ")}.`] : []),
					...(loaded.length < tools.length
						? [`Already loaded: ${tools.filter((name) => !loaded.includes(name)).join(", ")}.`]
						: []),
					...(unknown.length ? [`Unknown names: ${unknown.join(", ")}. Valid names: ${validNames.join(", ")}.`] : []),
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
			},
			renderCall(args, theme) {
				const names = Array.isArray(args?.names) ? args.names.join(", ") : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("load_tools"))} ${theme.fg("dim", names)}`, 0, 0);
			},
			renderResult(result, { isPartial }, theme) {
				if (isPartial) return new Text(theme.fg("warning", "Loading tools..."), 0, 0);
				const first = result?.content?.[0];
				return new Text(theme.fg("dim", first?.type === "text" ? first.text : ""), 0, 0);
			},
		});

		const restored = resolve(groups, usedOnBranch(ctx, accepted)).tools;
		if (restored.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...restored])]);
		state = "on";
	});
}
