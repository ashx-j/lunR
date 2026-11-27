/**
 * /usage, /context and /session for interactive mode: the session's token totals, costs, plan
 * usage and the estimated context-window breakdown, printed into the chat. InteractiveMode
 * supplies the session and chat through UsageCommandHost.
 */

import { CLAUDE_CODE_HISTORY_REPLAYED_NOTE, claudeCodeHistoryReplayed } from "@earendil-works/pi-ai";
import { type Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { computeCacheWaste } from "../../core/cache-stats.ts";
import { computeContextBreakdown } from "../../core/context-breakdown.ts";
import { getGlobalInstructionsPath, getModelInstructionsPath } from "../../core/model-instructions.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { collectUsageRequests, usageTokens } from "../../core/usage-accounting.ts";
import { getAllPlanUsageResults } from "../../core/usage-service.ts";
import { renderContextBox } from "./components/context-view.ts";
import { formatTokens } from "./components/footer.ts";
import { renderUsageBox } from "./components/usage-view.ts";
import { theme } from "./theme/theme.ts";

/** What /usage, /context and /session need from InteractiveMode. InteractiveMode builds one in `createChatViewHost`. */
export interface UsageCommandHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly ui: TUI;
	readonly chatContainer: Container;
	showStatus(message: string): void;
}

function collectUsageBreakdown(host: UsageCommandHost): ReturnType<typeof computeContextBreakdown> | undefined {
	const model = host.session.model;
	const contextWindow = model?.contextWindow ?? 0;
	if (!model || contextWindow <= 0) return undefined;
	const tools = host.session
		.getActiveToolNames()
		.map((name) => host.session.getToolDefinition(name))
		.filter((definition) => definition !== undefined);
	return computeContextBreakdown({
		systemPrompt: host.session.systemPrompt,
		tools,
		messages: host.session.messages,
		contextWindow,
		globalAgentsPath: getGlobalInstructionsPath(getAgentDir()),
		modelAgentsPath: getModelInstructionsPath(getAgentDir(), model.id),
	});
}

// lunr: /usage — current session only: token totals, live context split,
// context-window bar, and subscription plan usage.
export async function handleUsageCommand(host: UsageCommandHost): Promise<void> {
	const stats = host.session.getSessionStats();
	const sessionTotals =
		stats.tokens.total > 0 ||
		stats.parentUsage?.requests ||
		stats.parentUsage?.unknownRequests ||
		stats.parentUsage?.partialRequests
			? {
					input: stats.tokens.input,
					output: stats.tokens.output,
					cacheRead: stats.tokens.cacheRead,
					cacheWrite: stats.tokens.cacheWrite,
					total: stats.tokens.total,
					requests: stats.parentUsage?.requests,
					unknownRequests: stats.parentUsage?.unknownRequests,
					partialRequests: stats.parentUsage?.partialRequests,
				}
			: undefined;

	const context = host.session.getContextUsage();
	const provider = host.session.model?.provider;
	const planResult = await getAllPlanUsageResults(provider, host.session.modelRuntime);
	const breakdown = collectUsageBreakdown(host);

	const lines = renderUsageBox(
		{
			sessionTotals,
			childTotals: stats.childUsage,
			combinedTotals: stats.combinedUsage,
			context,
			plan: planResult.usages,
			breakdown,
		},
		host.ui.terminal.columns,
	);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
	if (planResult.errors.length > 0) host.showStatus(planResult.errors.join("\n"));
	host.ui.requestRender();
}

// lunr: /context — estimated breakdown of what consumes the context window
// (system prompt incl. project context files, tool definitions, and the live
// session messages). Uses session.messages, so post-compaction renders match
// the context the model actually sees.
export function handleContextCommand(host: UsageCommandHost): void {
	const model = host.session.model;
	const contextWindow = model?.contextWindow ?? 0;
	if (!model || contextWindow <= 0) {
		host.showStatus("No model selected or context window unknown.");
		return;
	}

	const breakdown = collectUsageBreakdown(host);
	if (!breakdown) {
		host.showStatus("No model selected or context window unknown.");
		return;
	}

	const lastReply = [...host.session.messages].reverse().find((message) => message.role === "assistant");
	const lines = renderContextBox(
		{
			breakdown,
			model: `${model.provider}/${model.id}`,
			compactionCeiling: host.session.getCompactionCeiling(),
			notice:
				lastReply?.role === "assistant" && claudeCodeHistoryReplayed(lastReply)
					? CLAUDE_CODE_HISTORY_REPLAYED_NOTE
					: undefined,
		},
		host.ui.terminal.columns,
	);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
	host.ui.requestRender();
}

export function handleSessionCommand(host: UsageCommandHost): void {
	const stats = host.session.getSessionStats();
	const sessionName = host.sessionManager.getSessionName();
	const entries = host.sessionManager.getEntries();
	const cacheWaste = computeCacheWaste(entries, host.session.modelRuntime);

	// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
	// resolves to a concrete responseModel), sorted by cost descending.
	const perModelMap = new Map<string, { key: string; cost: number; tokens: number }>();
	for (const request of collectUsageRequests(entries)) {
		const key = `${request.provider}/${request.model}`;
		const bucket = perModelMap.get(key) ?? { key, cost: 0, tokens: 0 };
		bucket.cost += request.usage.cost.total;
		bucket.tokens += usageTokens(request.usage);
		perModelMap.set(key, bucket);
	}
	const perModel = Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost);

	let info = `${theme.bold("Session Info")}\n\n`;
	if (sessionName) {
		info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
	}
	info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
	info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
	info += `${theme.bold("Messages")}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
	info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
	info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
	info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
	info += `${theme.bold("Parent tokens including auxiliary requests")}\n`;
	// "Input" is the full prompt volume. With cache activity, split it into
	// cached (served from cache) vs uncached (everything else) - the only
	// provider-independent split. Cache writes, where reported, are a detail
	// of the uncached portion.
	const { input, cacheRead, cacheWrite } = stats.tokens;
	const promptTokens = input + cacheRead + cacheWrite;
	info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
	if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
		const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
		info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
		const written = cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
		info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
	}
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;
	if (stats.childUsage?.total) {
		info += `Children: ${stats.childUsage.total.toLocaleString()} tokens, $${stats.childUsage.cost.toFixed(3)}\n`;
		info += `Combined: ${stats.combinedUsage?.total.toLocaleString()} tokens, $${stats.combinedUsage?.cost.toFixed(3)}\n`;
	}
	if (stats.parentUsage?.unknownRequests)
		info += `Usage unavailable for ${stats.parentUsage.unknownRequests} request(s).\n`;
	if (stats.parentUsage?.partialRequests)
		info += `Usage incomplete for ${stats.parentUsage.partialRequests} request(s).\n`;
	if (stats.parentUsage?.unknownCosts)
		info += `Pricing unavailable for ${stats.parentUsage.unknownCosts} request(s).\n`;
	info += "Costs use catalog estimates unless the provider reports its account charge.\n";

	if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
		info += `\n${theme.bold("Cost")}\n`;
		info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
		if (perModel.length > 1) {
			for (const entry of perModel) {
				info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
			}
		}
		if (cacheWaste.missedTokens > 0) {
			const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
			const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
			info +=
				cacheWaste.missedCost >= 0.0001
					? `\n${theme.fg("dim", "Estimated cache misses:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
					: `\n${theme.fg("dim", "Estimated cache misses:")} ${detail}`;
		}
	}

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}
