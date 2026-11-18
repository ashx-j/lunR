import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ContextBreakdown } from "../../../core/context-breakdown.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { renderThemedBox, usageBar } from "./usage-view.ts";

export interface ContextViewData {
	breakdown: ContextBreakdown;
	/** provider/model id shown in the box, when known. */
	model?: string;
	/** Warning shown under the total, such as a subscription history that is no longer prompt-cached. */
	notice?: string;
}

interface BreakdownRow {
	label: string;
	tokens: number;
	count?: number;
}

function renderRowLabel(row: BreakdownRow): string {
	return row.count !== undefined && row.count > 0 ? `${row.label} (${row.count})` : row.label;
}

function rowLine(row: BreakdownRow, labelWidth: number): string {
	const label = renderRowLabel(row);
	return `  ${label.padEnd(labelWidth)}  ${formatTokens(row.tokens)}`;
}

/**
 * Render the /context bordered box: an estimated breakdown of what consumes
 * the context window. Category rows are counts only; the estimated-total
 * row keeps the shared 20-cell usage bar.
 */
export function renderContextBox(data: ContextViewData, maxWidth: number): string[] {
	const { breakdown } = data;
	const content: string[] = [];

	if (data.model) content.push(data.model);
	content.push(
		theme.fg(
			"dim",
			"Estimated visible context, current session only. Actual tokens and hidden reasoning may differ.",
		),
	);
	content.push("");

	const rows: BreakdownRow[] = [
		{ label: "System prompt", tokens: breakdown.systemPrompt },
		...breakdown.contextFiles.map((file) => ({ label: file.label, tokens: file.tokens })),
		{ label: "Skills", tokens: breakdown.skills },
		{ label: "Tool definitions", tokens: breakdown.toolDefinitions },
		{ label: "User messages", tokens: breakdown.user, count: breakdown.counts.user },
		{ label: "Assistant text", tokens: breakdown.assistantText, count: breakdown.counts.assistantText },
		{ label: "Visible thinking", tokens: breakdown.thinking, count: breakdown.counts.thinking },
		{ label: "Tool calls", tokens: breakdown.toolCalls, count: breakdown.counts.toolCalls },
		{ label: "Tool results", tokens: breakdown.toolResults, count: breakdown.counts.toolResults },
		{ label: "Summaries", tokens: breakdown.summaries, count: breakdown.counts.summaries },
	].filter((row) => row.tokens > 0);

	const labelWidth = Math.max(...rows.map((row) => renderRowLabel(row).length), "Estimated total".length);
	for (const row of rows) {
		content.push(rowLine(row, labelWidth));
	}

	content.push("");
	const usedPercent = breakdown.contextWindow > 0 ? (breakdown.total / breakdown.contextWindow) * 100 : 0;
	content.push(
		`  ${"Estimated total".padEnd(labelWidth)}  ${usageBar(usedPercent)}  ${formatTokens(breakdown.total)} / ${formatTokens(breakdown.contextWindow)} (${Math.round(usedPercent)}%)`,
	);
	if (data.notice) {
		// Wrap to the box the rows already need, so the note does not widen it or get cut off.
		const width = Math.max(20, Math.min(Math.max(...content.map((line) => visibleWidth(line))), maxWidth - 4));
		content.push("", ...wrapTextWithAnsi(data.notice, width).map((line) => theme.fg("warning", line)));
	}

	return renderThemedBox(" Context ", content, maxWidth);
}
