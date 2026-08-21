import { beforeEach, describe, expect, test } from "vitest";
import lunrTodos, {
	buildTodoWidgetLines,
	summarizeTodos,
	TODO_WIDGET_COLLAPSED_ROWS,
	type TodoItem,
} from "../src/builtin-extensions/lunr-todos.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const todo = (id: string, content: string, status: TodoItem["status"] = "pending"): TodoItem => ({
	id,
	content,
	status,
});

describe("summarizeTodos", () => {
	test("empty list", () => {
		expect(summarizeTodos([])).toBe("No todos.");
	});

	test("counts in order: in progress, pending, completed", () => {
		const todos = [
			todo("1", "a", "pending"),
			todo("2", "b", "in_progress"),
			todo("3", "c", "completed"),
			todo("4", "d", "pending"),
		];
		expect(summarizeTodos(todos)).toBe("4 todos: 1 in progress, 2 pending, 1 completed");
	});

	test("omits zero-count statuses and singularizes", () => {
		expect(summarizeTodos([todo("1", "a", "completed")])).toBe("1 todo: 1 completed");
	});
});

describe("buildTodoWidgetLines", () => {
	test("empty list produces no lines", () => {
		expect(buildTodoWidgetLines([], false)).toEqual([]);
		expect(buildTodoWidgetLines([], true)).toEqual([]);
	});

	test("collapsed: in-progress first, then pending, no done summary", () => {
		const todos = [todo("1", "later", "pending"), todo("2", "now", "in_progress"), todo("3", "old", "completed")];
		const lines = buildTodoWidgetLines(todos, false);
		expect(lines.map((l) => l.text)).toEqual(["● now", "○ later"]);
	});

	test("collapsed: caps active rows and appends a hint line", () => {
		const todos = [
			todo("1", "a", "in_progress"),
			todo("2", "b", "pending"),
			todo("3", "c", "pending"),
			todo("4", "d", "pending"),
			todo("5", "e", "pending"),
			todo("6", "done", "completed"),
			todo("7", "done2", "completed"),
		];
		const lines = buildTodoWidgetLines(todos, false, "ctrl+o");
		const rows = lines.filter((l) => l.kind === "todo");
		expect(rows).toHaveLength(TODO_WIDGET_COLLAPSED_ROWS);
		expect(rows.map((l) => l.text)).toEqual(["● a", "○ b", "○ c"]);
		expect(lines.some((l) => l.kind === "summary")).toBe(false);
		expect(lines.some((l) => l.kind === "hint" && l.text === "+2 more")).toBe(true);
	});

	test("collapsed: no hint when active rows fit", () => {
		const todos = [todo("1", "a", "pending"), todo("2", "b", "pending")];
		const lines = buildTodoWidgetLines(todos, false);
		expect(lines.some((l) => l.kind === "hint")).toBe(false);
		expect(lines.some((l) => l.kind === "summary")).toBe(false);
	});

	test("collapsed: only completed items hide the widget", () => {
		const lines = buildTodoWidgetLines([todo("1", "a", "completed"), todo("2", "b", "completed")], false);
		expect(lines).toEqual([]);
	});

	test("expanded: shows every row, completed included, no hint or summary", () => {
		const todos = [
			todo("1", "a", "pending"),
			todo("2", "b", "in_progress"),
			todo("3", "c", "completed"),
			todo("4", "d", "pending"),
			todo("5", "e", "pending"),
		];
		const lines = buildTodoWidgetLines(todos, true);
		expect(lines.map((l) => l.text)).toEqual(["● b", "○ a", "○ d", "○ e", "✓ c"]);
		expect(lines.every((l) => l.kind === "todo")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Extension integration: drive the factory with a fake pi + ctx
// ---------------------------------------------------------------------------

const BRIDGE = Symbol.for("@lunr/tools-expanded-changed");

function createHarness() {
	let toolDef: any = null;
	const handlers = new Map<string, (...args: any[]) => void>();
	const widgets = new Map<string, { content: any; options: any } | undefined>();
	const fakeTheme = { fg: (_token: string, s: string) => s, bold: (s: string) => s };
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget(key: string, content: any, options?: any) {
				widgets.set(key, content === undefined ? undefined : { content, options });
			},
			getToolsExpanded: () => false,
		},
	};
	const pi = {
		registerTool(def: any) {
			toolDef = def;
		},
		on(event: string, handler: (...args: any[]) => void) {
			handlers.set(event, handler);
		},
	};
	lunrTodos(pi as any);
	return {
		toolDef: () => toolDef,
		ctx,
		fireSessionStart: () => handlers.get("session_start")?.({ type: "session_start" }, ctx),
		fireMessageStart: (role: string) =>
			handlers.get("message_start")?.({ type: "message_start", message: { role } }, ctx),
		fireTurnStart: () => handlers.get("turn_start")?.({ type: "turn_start" }, ctx),
		fireSessionShutdown: () => handlers.get("session_shutdown")?.({ type: "session_shutdown" }),
		widgetLines(): string[] {
			const entry = widgets.get("todos");
			if (!entry) return [];
			const component = typeof entry.content === "function" ? entry.content(null, fakeTheme) : entry.content;
			return component.render(120).map((line: string) => stripAnsi(line).trim());
		},
		widgetRemoved: () => widgets.get("todos") === undefined,
	};
}

describe("lunr-todos extension", () => {
	beforeEach(() => {
		delete (globalThis as any)[BRIDGE];
	});

	test("set semantics: tool result text summarizes, widget shows rows above the editor", async () => {
		const h = createHarness();
		h.fireSessionStart();
		const result = await h.toolDef().execute(
			"call-1",
			{
				todos: [
					todo("1", "write tests", "in_progress"),
					todo("2", "run build"),
					todo("3", "read spec", "completed"),
				],
			},
			null,
			null,
			h.ctx,
		);
		expect(result.content[0].text).toBe("3 todos: 1 in progress, 1 pending, 1 completed");
		expect(h.widgetLines()).toEqual(["● write tests", "○ run build"]);
	});

	test("full-replace: second call replaces, empty array clears and removes the widget", async () => {
		const h = createHarness();
		h.fireSessionStart();
		await h.toolDef().execute("c1", { todos: [todo("1", "a"), todo("2", "b")] }, null, null, h.ctx);
		expect(h.widgetLines()).toEqual(["○ a", "○ b"]);
		const result = await h.toolDef().execute("c2", { todos: [] }, null, null, h.ctx);
		expect(result.content[0].text).toBe("No todos.");
		expect(h.widgetRemoved()).toBe(true);
	});

	test("invalid entries are sanitized (unknown status → pending, blank content dropped)", async () => {
		const h = createHarness();
		h.fireSessionStart();
		const result = await h.toolDef().execute(
			"c1",
			{
				todos: [
					{ id: "1", content: "ok", status: "bogus" },
					{ id: "2", content: "  " },
				],
			},
			null,
			null,
			h.ctx,
		);
		expect(result.content[0].text).toBe("1 todo: 1 pending");
		expect(h.widgetLines()).toEqual(["○ ok"]);
	});

	test("expansion bridge flips the widget between collapsed and expanded", async () => {
		const h = createHarness();
		h.fireSessionStart();
		const todos = [
			todo("1", "a", "in_progress"),
			todo("2", "b"),
			todo("3", "c"),
			todo("4", "d"),
			todo("5", "e", "completed"),
		];
		await h.toolDef().execute("c1", { todos }, null, null, h.ctx);
		const collapsed = h.widgetLines();
		expect(collapsed.filter((l) => l.startsWith("●") || l.startsWith("○"))).toHaveLength(3);
		expect(collapsed.some((l) => l === "✓ 1 done")).toBe(false);
		expect(collapsed.some((l) => l.startsWith("+1 more"))).toBe(true);

		(globalThis as any)[BRIDGE]?.(true);
		expect(h.widgetLines()).toEqual(["● a", "○ b", "○ c", "○ d", "✓ e"]);

		(globalThis as any)[BRIDGE]?.(false);
		expect(h.widgetLines().some((l) => l.startsWith("+1 more"))).toBe(true);
	});

	test("user message_start prunes completed items from the expanded widget", async () => {
		const h = createHarness();
		h.fireSessionStart();
		await h.toolDef().execute(
			"c1",
			{
				todos: [todo("1", "a", "completed"), todo("2", "b", "completed")],
			},
			null,
			null,
			h.ctx,
		);
		(globalThis as any)[BRIDGE]?.(true);
		expect(h.widgetLines()).toEqual(["✓ a", "✓ b"]);
		h.fireTurnStart();
		h.fireMessageStart("assistant");
		expect(h.widgetLines()).toEqual(["✓ a", "✓ b"]);
		h.fireMessageStart("user");
		expect(h.widgetRemoved()).toBe(true);
	});

	test("session_shutdown removes the widget and unregisters the bridge", async () => {
		const h = createHarness();
		h.fireSessionStart();
		await h.toolDef().execute("c1", { todos: [todo("1", "a")] }, null, null, h.ctx);
		expect(typeof (globalThis as any)[BRIDGE]).toBe("function");
		h.fireSessionShutdown();
		expect(h.widgetRemoved()).toBe(true);
		expect((globalThis as any)[BRIDGE]).toBeUndefined();
	});

	test("chat render stays one line (renderCall/renderResult)", async () => {
		const h = createHarness();
		const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
		const callText = h
			.toolDef()
			.renderCall({ todos: [todo("1", "a"), todo("2", "b")] }, theme)
			.render(120);
		expect(callText.map(stripAnsi).join("")).toContain("todo");
		expect(callText.map(stripAnsi).join("")).toContain("2 items");
		const result = await h.toolDef().execute("c1", { todos: [todo("1", "a")] }, null, null, h.ctx);
		const resultText = h.toolDef().renderResult(result, { isPartial: false }, theme).render(120);
		expect(resultText.map(stripAnsi).join("")).toContain("1 todo: 1 pending");
	});
});
