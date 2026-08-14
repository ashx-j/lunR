// @ts-nocheck
/**
 * lunr-todos — lunR-native agent todo list with an above-editor widget.
 *
 * lunR: this file is lunR-native (not an absorbed upstream extension).
 *
 *  - One `todo` tool (TypeBox), full-replace semantics: every call sends the
 *    ENTIRE list; an empty array clears it. State is per-session, in-memory
 *    only (extension closure) — nothing is persisted.
 *  - Chat render is a quiet one-liner (renderCall/renderResult), matching the
 *    cron tool's minimal footprint.
 *  - After every state change the list is mirrored into a `todos` widget above
 *    the editor (component factory, so MAX_WIDGET_LINES string truncation does
 *    not apply). Collapsed: up to 3 active rows (in-progress first, then
 *    pending) + a `✓ N done` summary + a `+N more (<key> to expand)` hint.
 *    Expanded: every row, completed included.
 *  - Expansion follows the global ctrl+o toggle via the
 *    `@lunr/tools-expanded-changed` bridge, invoked from
 *    interactive-mode.ts `setToolsExpanded` (initial state is read from
 *    `ctx.ui.getToolsExpanded()`).
 *
 * The pure logic (summarizeTodos / buildTodoWidgetLines) is exported for
 * vitest — see test/lunr-todos.test.ts.
 *
 * `// @ts-nocheck` matches the builtin-extension convention (see lunr-cron).
 * Runtime imports stay on concrete core modules — never the package barrel.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { keyText } from "../modes/interactive/components/keybinding-hints.ts";

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
}

export interface TodoWidgetLine {
	kind: "todo" | "summary" | "hint";
	status?: TodoStatus;
	text: string;
}

/** Collapsed widget shows at most this many active (non-completed) rows. */
export const TODO_WIDGET_COLLAPSED_ROWS = 3;

const STATUS_GLYPHS: Record<TodoStatus, string> = {
	in_progress: "●",
	pending: "○",
	completed: "✓",
};

/** Short model-facing summary, e.g. "4 todos: 1 in progress, 2 pending, 1 completed". */
export function summarizeTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "No todos.";
	const count = (s: TodoStatus) => todos.filter((t) => t.status === s).length;
	const parts: string[] = [];
	const inProgress = count("in_progress");
	const pending = count("pending");
	const completed = count("completed");
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} pending`);
	if (completed > 0) parts.push(`${completed} completed`);
	return `${todos.length} todo${todos.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/**
 * Widget lines for the current list. Collapsed mode shows up to
 * TODO_WIDGET_COLLAPSED_ROWS active rows (in-progress first, then pending),
 * collapses completed items into a `✓ N done` summary, and appends a
 * `+N more (<expandKey> to expand)` hint when active rows are hidden.
 * Expanded mode shows every row. Empty list → no lines (widget removed).
 */
export function buildTodoWidgetLines(todos: TodoItem[], expanded: boolean, expandKey = "ctrl+o"): TodoWidgetLine[] {
	if (todos.length === 0) return [];
	const row = (t: TodoItem): TodoWidgetLine => ({
		kind: "todo",
		status: t.status,
		text: `${STATUS_GLYPHS[t.status]} ${t.content}`,
	});
	const active = [
		...todos.filter((t) => t.status === "in_progress"),
		...todos.filter((t) => t.status === "pending"),
	];
	const done = todos.filter((t) => t.status === "completed");
	if (expanded) {
		return [...active.map(row), ...done.map(row)];
	}
	const lines: TodoWidgetLine[] = active.slice(0, TODO_WIDGET_COLLAPSED_ROWS).map(row);
	if (done.length > 0) {
		lines.push({ kind: "summary", text: `✓ ${done.length} done` });
	}
	const hidden = active.length - TODO_WIDGET_COLLAPSED_ROWS;
	if (hidden > 0) {
		lines.push({ kind: "hint", text: `+${hidden} more (${expandKey} to expand)` });
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const WIDGET_KEY = "todos";
const EXPANDED_BRIDGE_SYMBOL = Symbol.for("@lunr/tools-expanded-changed");

export default function (pi: ExtensionAPI): void {
	let todos: TodoItem[] = [];
	let expanded = false;
	let lastCtx: ExtensionContext | null = null;

	function colorize(line: TodoWidgetLine, theme: any): string {
		if (line.kind === "summary" || line.kind === "hint") return theme.fg("muted", line.text);
		if (line.status === "in_progress") return theme.fg("accent", line.text);
		if (line.status === "completed") return theme.fg("dim", line.text);
		return line.text;
	}

	function refreshWidget(): void {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines = buildTodoWidgetLines(todos, expanded, keyText("app.tools.expand"));
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: unknown, theme: any) => new Text(lines.map((l) => colorize(l, theme)).join("\n"), 1, 0),
			{ placement: "aboveEditor" },
		);
	}

	// --- Expansion bridge (interactive-mode setToolsExpanded invokes this) ---
	function registerExpandedBridge(): void {
		(globalThis as Record<symbol, unknown>)[EXPANDED_BRIDGE_SYMBOL] = (value: boolean) => {
			expanded = Boolean(value);
			refreshWidget();
		};
	}
	registerExpandedBridge();

	// --- Session lifecycle: per-session in-memory state ---
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		todos = [];
		expanded = ctx.hasUI ? (ctx.ui.getToolsExpanded?.() ?? false) : false;
		registerExpandedBridge();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("session_shutdown", () => {
		if (lastCtx?.hasUI) lastCtx.ui.setWidget(WIDGET_KEY, undefined);
		lastCtx = null;
		delete (globalThis as Record<symbol, unknown>)[EXPANDED_BRIDGE_SYMBOL];
	});

	// --- todo tool (agent-facing) ---
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage the session todo list shown above the user's editor. Full-replace semantics:",
			"every call must send the ENTIRE list; send an empty array to clear it.",
			"Each item: { id, content, status: 'pending' | 'in_progress' | 'completed' }.",
			"Use it to track multi-step work; keep exactly one item in_progress at a time.",
		].join("\n"),
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					id: Type.String({ description: "Stable id for the item." }),
					content: Type.String({ description: "Short description of the task." }),
					status: Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
					]),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
			const incoming = Array.isArray(params?.todos) ? params.todos : [];
			todos = incoming
				.filter((t: any) => t && typeof t.content === "string" && t.content.trim().length > 0)
				.map((t: any, i: number) => ({
					id: typeof t.id === "string" && t.id ? t.id : String(i + 1),
					content: t.content.trim(),
					status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending",
				}));
			lastCtx = ctx;
			refreshWidget();
			return text(summarizeTodos(todos));
		},
		renderCall(args, theme) {
			const n = Array.isArray(args?.todos) ? args.todos.length : 0;
			const detail = n === 0 ? "clear" : `${n} item${n === 1 ? "" : "s"}`;
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("dim", detail), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Updating todos..."), 0, 0);
			const first = result?.content?.[0];
			const summary = first?.type === "text" ? first.text : "";
			return new Text(theme.fg("dim", summary), 0, 0);
		},
	});
}
