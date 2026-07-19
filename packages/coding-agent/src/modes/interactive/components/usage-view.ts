import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanUsage, PlanUsageWindow } from "../../../core/usage-service.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

/** Per-model session token totals for the /usage box. */
export interface UsageSessionRow {
	model: string;
	input: number;
	output: number;
	total: number;
}

export interface UsageViewData {
	sessionRows: UsageSessionRow[];
	context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	plan: PlanUsage | undefined;
}

const BAR_CELLS = 20;

/** 20-cell monochrome bar: `████░░░░░░░░░░░░░░░░`. */
export function usageBar(percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_CELLS);
	return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
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
 * Render the /usage bordered box (monochrome, moon theme conventions).
 * `maxWidth` is the available terminal width; content truncates to fit.
 */
export function renderUsageBox(data: UsageViewData, maxWidth: number): string[] {
	const content: string[] = [];

	if (data.sessionRows.length > 0) {
		content.push("Session usage");
		for (const row of data.sessionRows) {
			content.push(
				`  ${row.model}   input ${formatTokens(row.input)}  output ${formatTokens(row.output)}  ${formatTokens(row.total)}`,
			);
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

	// Box width: widest content + `│ ` / ` │` chrome, capped by the terminal.
	const contentWidth = Math.max(...content.map((line) => visibleWidth(line)));
	const totalWidth = Math.max(24, Math.min(contentWidth + 4, Math.max(24, maxWidth)));
	const innerWidth = totalWidth - 4;

	const border = (text: string): string => theme.fg("border", text);
	const headerText = " Usage ";
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
