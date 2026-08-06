import type { ContextBreakdown } from "../../../core/context-breakdown.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { renderThemedBox, usageBar } from "./usage-view.ts";

export interface ContextViewData {
	breakdown: ContextBreakdown;
	/** provider/model id shown in the box, when known. */
	model?: string;
}

interface BreakdownRow {
	label: string;
	tokens: number;
	count?: number;
}

function renderRowLabel(row: BreakdownRow): string {
	return row.count !== undefined && row.count > 0 ? `${row.label} (${row.count})` : row.label;
}

function rowLine(row: BreakdownRow, labelWidth: number, denominator: number): string {
	const percent = denominator > 0 ? (row.tokens / denominator) * 100 : 0;
	const label = renderRowLabel(row);
	return `  ${label.padEnd(labelWidth)}  ${usageBar(percent)}  ${formatTokens(row.tokens)}`;
}

/**
 * Render the /context bordered box: an estimated breakdown of what consumes
 * the context window. Shares the box chrome and 20-cell bars with /usage.
 */
export function renderContextBox(data: ContextViewData, maxWidth: number): string[] {
	const { breakdown } = data;
	const content: string[] = [];

	if (data.model) content.push(data.model);
	content.push(theme.fg("dim", "Estimated (chars/4), current session only — actual token counts may differ."));
	content.push("");

	const rows: BreakdownRow[] = [
		{ label: "System prompt + files", tokens: breakdown.systemPrompt },
		{ label: "Tool definitions", tokens: breakdown.toolDefinitions },
		{ label: "User messages", tokens: breakdown.user, count: breakdown.counts.user },
		{ label: "Assistant text", tokens: breakdown.assistantText, count: breakdown.counts.assistantText },
		{ label: "Thinking", tokens: breakdown.thinking, count: breakdown.counts.thinking },
		{ label: "Tool calls", tokens: breakdown.toolCalls, count: breakdown.counts.toolCalls },
		{ label: "Tool results", tokens: breakdown.toolResults, count: breakdown.counts.toolResults },
		{ label: "Summaries", tokens: breakdown.summaries, count: breakdown.counts.summaries },
	].filter((row) => row.tokens > 0);

	const labelWidth = Math.max(...rows.map((row) => renderRowLabel(row).length), "Estimated total".length);
	for (const row of rows) {
		content.push(rowLine(row, labelWidth, breakdown.total));
	}

	content.push("");
	const usedPercent = breakdown.contextWindow > 0 ? (breakdown.total / breakdown.contextWindow) * 100 : 0;
	content.push(
		`  ${"Estimated total".padEnd(labelWidth)}  ${usageBar(usedPercent)}  ${formatTokens(breakdown.total)} / ${formatTokens(breakdown.contextWindow)} (${Math.round(usedPercent)}%)`,
	);

	return renderThemedBox(" Context ", content, maxWidth);
}
