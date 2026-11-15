import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { BashToolDetails, createBashToolDefinition } from "../../../core/tools/bash.ts";
import { truncateToVisualLines } from "../components/visual-truncate.ts";
import { theme } from "../theme/theme.ts";
import {
	GroupedCallText,
	getTextOutput,
	invalidArgText,
	str,
	type ToolRendererFor,
	toolGroupTree,
	toolStatusDotFromContext,
} from "./render-utils.ts";

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

// lunr: slim header — collapsed calls show only the first line of the command,
// capped at this many chars; an ellipsis marks either kind of truncation.
const MAX_COLLAPSED_COMMAND_CHARS = 100;

function formatBashCall(
	args: { command?: string; timeout?: number; run_in_background?: boolean } | undefined,
	options?: { expanded?: boolean; compact?: boolean },
): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	// lunr: compact-by-default — the timeout suffix is noise on a one-line header;
	// it stays visible while streaming and in the expanded view.
	const timeoutSuffix = timeout && !options?.compact ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	let commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	if (!options?.expanded && command) {
		const firstLine = command.split("\n")[0];
		const capped = firstLine.length > MAX_COLLAPSED_COMMAND_CHARS;
		const base = capped ? firstLine.slice(0, MAX_COLLAPSED_COMMAND_CHARS) : firstLine;
		commandDisplay = capped || base.length < command.length ? `${base} …` : base;
	}
	if (command) {
		commandDisplay = theme.fg("toolTitle", theme.bold(commandDisplay));
	}
	const backgroundSuffix = args?.run_in_background ? theme.fg("muted", " (background)") : "";
	return commandDisplay + timeoutSuffix + backgroundSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	// lunr: compact-by-default — finished, successful, non-expanded calls skip the
	// output preview and the "Took" footer (duration moves into the call header).
	compact = false,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (!compact && output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = theme.fg("muted", `... (${state.cachedSkipped} earlier lines)`);
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	// lunr: the truncation/full-output notice is intentionally NOT rendered in
	// the TUI — the model still gets it in the result text (formatOutput), and
	// the temp-log path is noise on screen.

	if (!compact && startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export const bashToolRenderer: ToolRendererFor<ReturnType<typeof createBashToolDefinition>, BashRenderState> = {
	renderCall(args, _theme, context) {
		const state = context.state;
		if (context.executionStarted && state.startedAt === undefined) {
			state.startedAt = Date.now();
			state.endedAt = undefined;
		}
		// lunr: compact-by-default — stamp endedAt here too: renderCall runs before
		// renderResult on the final update, and the header needs the duration.
		if (!context.isPartial && state.startedAt !== undefined) {
			state.endedAt ??= Date.now();
		}
		// lunr: compact-by-default — a finished, successful, non-expanded call
		// renders as a single slim header line with the duration folded in.
		const compact = !context.isPartial && !context.expanded && !context.isError;
		let detail = formatBashCall(args, { expanded: context.expanded, compact });
		if (compact && state.startedAt !== undefined && state.endedAt !== undefined) {
			detail += theme.fg("muted", ` — Took ${formatDuration(state.endedAt - state.startedAt)}`);
		}
		const text = (context.lastComponent as GroupedCallText | undefined) ?? new GroupedCallText("", 0, 0);
		text.setCall({
			role: context.groupRole ?? "singleton",
			compact,
			tree: toolGroupTree(context),
			dot: toolStatusDotFromContext(context, theme),
			title: theme.fg("toolTitle", theme.bold("$")),
			detail,
		});
		return text;
	},
	renderResult(result, options, _theme, context) {
		const state = context.state;
		if (state.startedAt !== undefined && options.isPartial && !state.interval) {
			state.interval = setInterval(() => context.invalidate(), 1000);
		}
		if (!options.isPartial || context.isError) {
			state.endedAt ??= Date.now();
			if (state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}
		}
		const component =
			(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
		// lunr: compact-by-default — suppresses the output preview + "Took" footer.
		const compact = !options.isPartial && !options.expanded && !context.isError;
		rebuildBashResultRenderComponent(
			component,
			result as any,
			options,
			context.showImages,
			state.startedAt,
			state.endedAt,
			compact,
		);
		component.invalidate();
		return component;
	},
};
