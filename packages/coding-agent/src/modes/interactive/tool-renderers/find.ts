import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { createFindToolDefinition, FindToolDetails } from "../../../core/tools/find.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../../core/tools/truncate.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import type { Theme } from "../theme/theme.ts";
import {
	GroupedCallText,
	getTextOutput,
	invalidArgText,
	renderCollapsedSearchPath,
	shortenPath,
	str,
	type ToolRendererFor,
	toolGroupTree,
	toolStatusDotFromContext,
} from "./render-utils.ts";

function formatFindCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: Theme,
	cwd: string,
	compact = false,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text = pattern === null ? invalidArg : theme.fg("accent", pattern || "");
	if (compact) {
		const collapsedPath = renderCollapsedSearchPath(rawPath, theme, cwd);
		if (collapsedPath) text += theme.fg("toolOutput", " in ") + collapsedPath;
	} else {
		const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
		text += theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	}
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const findToolRenderer: ToolRendererFor<ReturnType<typeof createFindToolDefinition>> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as GroupedCallText | undefined) ?? new GroupedCallText("", 0, 0);
		const compact = !context.isPartial && !context.expanded && !context.isError;
		text.setCall({
			role: context.groupRole ?? "singleton",
			compact,
			tree: toolGroupTree(context),
			dot: toolStatusDotFromContext(context, theme),
			title: theme.fg("toolTitle", theme.bold("find")),
			detail: formatFindCall(args, theme, context.cwd, !context.expanded),
		});
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// lunr: compact-by-default — finished, successful, non-expanded calls
		// render header-only (ctrl+o reveals the full result). Notices stay in
		// execute() output for the model, not in TUI chrome.
		if (!options.isPartial && !options.expanded && !context.isError) {
			text.setText("");
			return text;
		}
		text.setText(formatFindResult(result as any, options, theme, context.showImages));
		return text;
	},
};
