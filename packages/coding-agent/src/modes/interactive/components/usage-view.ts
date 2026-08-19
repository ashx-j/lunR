import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextBreakdown } from "../../../core/context-breakdown.ts";
import type { PlanUsage, PlanUsageWindow } from "../../../core/usage-service.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

/** Simple token totals (rendered by /usage). */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	total: number;
}

export interface UsageViewData {
	/** Session-wide token totals (summed across models); omitted when no usage yet. */
	sessionTotals: UsageTotals | undefined;
	context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	plan: PlanUsage | undefined;
	/** Live session context split; omitted when the window is unknown. */
	breakdown?: ContextBreakdown;
}

const BAR_CELLS = 20;

/** Traffic-light token for a 0–100 usage percent. Matches footer thresholds. */
export function usageLevelColor(percent: number): "success" | "warning" | "error" {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "success";
}

/** `cached X (Y%)` where Y = cacheRead / (input + cacheRead + cacheWrite). */
function formatCachedSuffix(input: number, cacheRead: number, cacheWrite: number): string {
	if (cacheRead <= 0) return "";
	const prompt = input + cacheRead + cacheWrite;
	if (prompt <= 0) return "";
	const percent = Math.round((cacheRead / prompt) * 100);
	return `  cached ${formatTokens(cacheRead)} (${percent}%)`;
}

/** 20-cell bar: filled cells green / yellow / red, empty cells dim. */
export function usageBar(percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_CELLS);
	const empty = BAR_CELLS - filled;
	const fill = filled > 0 ? theme.fg(usageLevelColor(clamped), "█".repeat(filled)) : "";
	const rest = empty > 0 ? theme.fg("dim", "░".repeat(empty)) : "";
	return fill + rest;
}

/** Compact countdown: `6d 21h`, `2h 51m`, `45m`, `now`. */
export function formatResetCountdown(resetsAt: number, now: number = Date.now()): string {
	const diff = resetsAt - now;
	if (diff <= 0) return "now";
	const minutes = Math.floor(diff / 60000);
	if (minutes >= 24 * 60) {
		const days = Math.floor(minutes / (24 * 60));
		const hours = Math.floor((minutes % (24 * 60)) / 60);
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	}
	return `${Math.max(1, minutes)}m`;
}

function planWindowLine(window: PlanUsageWindow, labelWidth: number): string {
	const pct = `${Math.round(window.usedPercent)}% used`;
	const reset = window.resetsAt !== undefined ? `  resets in ${formatResetCountdown(window.resetsAt)}` : "";
	return `  ${window.label.padEnd(labelWidth)}  ${usageBar(window.usedPercent)}  ${pct}${reset}`;
}

/**
 * Shared bordered box chrome (monochrome, moon theme conventions) used by
 * /usage and /context. `headerText` includes its surrounding spaces (e.g.
 * " Usage "). `maxWidth` is the available terminal width; content truncates
 * to fit.
 */
export function renderThemedBox(headerText: string, content: string[], maxWidth: number): string[] {
	// Box width: widest content + `│ ` / ` │` chrome, capped by the terminal.
	const contentWidth = Math.max(...content.map((line) => visibleWidth(line)));
	const totalWidth = Math.max(24, Math.min(contentWidth + 4, Math.max(24, maxWidth)));
	const innerWidth = totalWidth - 4;

	const border = (text: string): string => theme.fg("border", text);
	const top = border(`╭${headerText}${"─".repeat(Math.max(0, totalWidth - 2 - headerText.length))}╮`);
	const bottom = border(`╰${"─".repeat(totalWidth - 2)}╯`);
	const lines = [top];
	for (const rawLine of content) {
		const line = rawLine.length > 0 ? truncateToWidth(rawLine, innerWidth, "") : "";
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		lines.push(`${border("│ ")}${line}${padding}${border(" │")}`);
	}
	lines.push(bottom);
	return lines;
}

/**
 * Render the /usage bordered box (moon theme conventions).
 * Current session only: token totals, live context split, window bar, plan quota.
 * `maxWidth` is the available terminal width; content truncates to fit.
 */
export function renderUsageBox(data: UsageViewData, maxWidth: number): string[] {
	const content: string[] = [];

	if (data.sessionTotals && data.sessionTotals.total > 0) {
		content.push("Session usage");
		content.push(
			`  input ${formatTokens(data.sessionTotals.input)}  output ${formatTokens(data.sessionTotals.output)}  total ${formatTokens(data.sessionTotals.total)}${formatCachedSuffix(data.sessionTotals.input, data.sessionTotals.cacheRead ?? 0, data.sessionTotals.cacheWrite ?? 0)}`,
		);
	}

	if (data.breakdown) {
		if (content.length > 0) content.push("");
		content.push("Context");
		content.push(theme.fg("dim", "Estimated (chars/4), current session only — actual token counts may differ."));
		const rows: { label: string; tokens: number }[] = [
			{ label: "System prompt", tokens: data.breakdown.systemPrompt },
			...data.breakdown.contextFiles.map((file) => ({ label: file.label, tokens: file.tokens })),
			{ label: "Skills", tokens: data.breakdown.skills },
			{ label: "Tool definitions", tokens: data.breakdown.toolDefinitions },
			{ label: "User messages", tokens: data.breakdown.user },
			{ label: "Assistant text", tokens: data.breakdown.assistantText },
			{ label: "Thinking", tokens: data.breakdown.thinking },
			{ label: "Tool calls", tokens: data.breakdown.toolCalls },
			{ label: "Tool results", tokens: data.breakdown.toolResults },
			{ label: "Summaries", tokens: data.breakdown.summaries },
			{ label: "Free", tokens: data.breakdown.free },
		].filter((row) => row.tokens > 0);
		if (rows.length > 0) {
			const labelWidth = Math.max(...rows.map((row) => row.label.length));
			for (const row of rows) {
				content.push(`  ${row.label.padEnd(labelWidth)}  ${formatTokens(row.tokens)}`);
			}
		}
	}

	if (data.context) {
		const pct = data.context.percent;
		const tokens = data.context.tokens;
		if (content.length > 0) content.push("");
		content.push("Context window");
		const pctText = pct == null ? "?" : `${Math.round(pct)}%`;
		const tokensText = tokens == null ? "?" : formatTokens(tokens);
		content.push(
			`  ${usageBar(pct ?? 0)}  ${pctText}  (${tokensText} / ${formatTokens(data.context.contextWindow)})`,
		);
	}

	if (data.plan && data.plan.windows.length > 0) {
		if (content.length > 0) content.push("");
		content.push(data.plan.planLabel ? `Plan usage (${data.plan.planLabel})` : "Plan usage");
		const labelWidth = Math.max(...data.plan.windows.map((window) => window.label.length));
		for (const window of data.plan.windows) {
			content.push(planWindowLine(window, labelWidth));
		}
	}

	if (content.length === 0) content.push("No usage data yet.");

	return renderThemedBox(" Usage ", content, maxWidth);
}
