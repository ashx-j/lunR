import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { getReadmePath } from "../../../config.ts";
import type { ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import type { createReadToolDefinition, ReadToolDetails } from "../../../core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../theme/theme.ts";
import {
	GroupedCallText,
	getTextOutput,
	renderToolFileName,
	replaceTabs,
	str,
	type ToolRendererFor,
	toolGroupTree,
	toolStatusDotFromContext,
} from "./render-utils.ts";

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadDetail(args: ReadRenderArgs | undefined, theme: Theme, cwd: string, expanded = false): string {
	const pathDisplay = renderToolFileName(str(args?.file_path ?? args?.path), theme, cwd);
	const range = expanded ? formatReadLineRange(args, theme) : "";
	return `${pathDisplay}${range}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export const readToolRenderer: ToolRendererFor<ReturnType<typeof createReadToolDefinition>> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as GroupedCallText | undefined) ?? new GroupedCallText("", 0, 0);
		const compact = !context.isPartial && !context.expanded && !context.isError;
		const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
		let title = theme.fg("toolTitle", theme.bold("read"));
		let detail: string;
		if (classification?.kind === "skill") {
			title = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			detail = theme.fg("customMessageText", classification.label);
		} else if (classification) {
			title = theme.fg("toolTitle", theme.bold(`read ${classification.kind}`));
			detail = theme.fg("accent", classification.label);
		} else {
			detail = formatReadDetail(args, theme, context.cwd, context.expanded);
		}
		text.setCall({
			role: context.groupRole ?? "singleton",
			compact,
			tree: toolGroupTree(context),
			dot: toolStatusDotFromContext(context, theme),
			title,
			detail,
		});
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// lunr: compact-by-default — finished, successful, non-expanded calls
		// render header-only (ctrl+o reveals the full result). Continuation
		// notices stay in execute() output for the model, not in TUI chrome.
		if (!options.isPartial && !options.expanded && !context.isError) {
			text.setText("");
			return text;
		}
		text.setText(
			formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
		);
		return text;
	},
};
