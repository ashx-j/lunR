import * as os from "node:os";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolGroupRole } from "../extensions/types.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

// lunr: compact-by-default — tool execute() paths append truncation/limit notices
// as a trailing "\n\n[...]" block. Compact (header-only) results blank the body,
// so this extracts that notice to keep it visible without the full output.
export function extractTrailingNotice(text: string): string | undefined {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("]")) return undefined;
	const start = trimmed.lastIndexOf("\n\n[");
	if (start === -1) return undefined;
	return trimmed.slice(start + 2);
}

export type ToolStatusDotState = "pending" | "success" | "error";

export type { ToolGroupRole };

export function toolGroupRole(continuation: boolean, followed: boolean): ToolGroupRole {
	if (!continuation && followed) return "first";
	if (continuation && followed) return "middle";
	if (continuation && !followed) return "last";
	return "singleton";
}

/**
 * Quieter same-name chrome: the verb is printed once, then files hang off a tree.
 *
 * ```
 * ● read
 *   ├─ resolve.ts
 *   └─ usage-service.ts
 * ```
 *
 * Singletons and expanded rows keep `● title detail` on one line.
 * Collapsed errors stay in the same-name tree; the error body is hoisted
 * under the last leaf so it does not split the file list. Grouped still-running
 * cards share the same tree as finished ones. `compact` is header-only body
 * hiding at the caller; pass `tree` for chrome. `isError` is accepted so
 * callers can keep passing it, but it does not drop tree chrome.
 */
export function toolGroupTree(context: { expanded?: boolean; isError?: boolean }): boolean {
	return !context.expanded;
}

export function formatGroupedCall(opts: {
	role: ToolGroupRole;
	compact?: boolean;
	tree?: boolean;
	dot: string;
	title: string;
	detail?: string;
}): string {
	const detail = opts.detail?.trim() ? opts.detail : "";
	const useTree = (opts.tree ?? opts.compact === true) && opts.role !== "singleton" && detail.length > 0;
	if (!useTree) {
		return detail ? `${opts.dot} ${opts.title} ${detail}` : `${opts.dot} ${opts.title}`;
	}
	const branch = opts.role === "last" ? "└─" : "├─";
	if (opts.role === "first") {
		return `${opts.dot} ${opts.title}\n  ${branch} ${detail}`;
	}
	return `  ${branch} ${detail}`;
}

/**
 * Colored status dot used as the sole state indicator on tool titles (moon theme:
 * backgrounds stay neutral). Pending = muted, success = green, error = red.
 */
export function toolStatusDot(state: ToolStatusDotState, theme: Theme): string {
	return theme.fg(state === "pending" ? "muted" : state, "●");
}

/** Derive the status dot from a render context (partial → pending, error → error, else success). */
export function toolStatusDotFromContext(context: { isPartial: boolean; isError: boolean }, theme: Theme): string {
	return toolStatusDot(context.isPartial ? "pending" : context.isError ? "error" : "success", theme);
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

/** Basename-only path for compact tool headers. Still hyperlinked to the absolute file. */
export function renderToolFileName(rawPath: string | null, theme: Theme, cwd: string): string {
	if (rawPath === null) return invalidArgText(theme);
	if (!rawPath) return theme.fg("toolOutput", "...");
	const name = basename(rawPath) || rawPath;
	return linkPath(theme.fg("accent", name), rawPath, cwd);
}

/**
 * Collapsed grep/find path. Omits cwd (`.` / empty) so the header stays one line.
 * Other paths are basename-only and hyperlinked.
 */
export function renderCollapsedSearchPath(rawPath: string | null, theme: Theme, cwd: string): string | undefined {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath.trim();
	if (!value || value === "." || value === "./") return undefined;
	return renderToolFileName(value, theme, cwd);
}
