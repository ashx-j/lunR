import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { createWriteToolDefinition } from "../../../core/tools/write.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../theme/theme.ts";
import {
	GroupedCallText,
	normalizeDisplayText,
	renderToolFileName,
	renderToolPath,
	replaceTabs,
	str,
	type ToolRendererFor,
	toolGroupTree,
	toolStatusDotFromContext,
} from "./render-utils.ts";

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends GroupedCallText {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
	// lunr: compact-by-default — finished, successful, non-expanded calls render
	// header-only; the content preview stays while streaming and when expanded.
	compact = false,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = compact ? renderToolFileName(rawPath, theme, cwd) : renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent && !compact) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export const writeToolRenderer: ToolRendererFor<ReturnType<typeof createWriteToolDefinition>> = {
	renderCall(args, theme, context) {
		const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
		const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
		const fileContent = str(renderArgs?.content);
		const component =
			(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
		if (fileContent !== null) {
			component.cache = context.argsComplete
				? rebuildWriteHighlightCacheFull(rawPath, fileContent)
				: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
		} else {
			component.cache = undefined;
		}
		const compact = !context.isPartial && !context.expanded && !context.isError;
		const tree = toolGroupTree(context);
		if (compact || (tree && context.groupRole && context.groupRole !== "singleton")) {
			const pathDisplay = renderToolFileName(rawPath, theme, context.cwd);
			let detail = pathDisplay;
			if (fileContent === null) {
				detail += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
			}
			component.setCall({
				role: context.groupRole ?? "singleton",
				compact,
				tree,
				dot: toolStatusDotFromContext(context, theme),
				title: theme.fg("toolTitle", theme.bold("write")),
				detail,
			});
		} else {
			component.setText(
				`${toolStatusDotFromContext(context, theme)} ${formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
					false,
				)}`,
			);
		}
		return component;
	},
	renderResult(result, _options, theme, context) {
		const output = formatWriteResult({ ...result, isError: context.isError }, theme);
		if (!output) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			return component;
		}
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(output);
		return text;
	},
};
