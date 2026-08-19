import { join, resolve } from "node:path";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { applySameToolGrouping, ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function isBlank(line: string | undefined): boolean {
	return line !== undefined && stripAnsi(line).trim() === "";
}

function headerIndex(lines: string[], needle: string): number {
	return lines.findIndex((line) => stripAnsi(line).includes(needle));
}

function compactRead(toolCallId: string, path: string): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"read",
		toolCallId,
		{ path },
		{},
		createReadToolDefinition(process.cwd()),
		createFakeTui(),
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: path }], details: undefined, isError: false }, false);
	return component;
}

function renderGroupedTools(...components: ToolExecutionComponent[]): string[] {
	const parent = new Container();
	let previous: ToolExecutionComponent | undefined;
	for (const component of components) {
		applySameToolGrouping(previous, component);
		parent.addChild(component);
		previous = component;
	}
	return parent.render(80);
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("moon");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		// lunr: the truncation/full-output notice is not rendered in the TUI at all;
		// the model-facing result text still carries it (covered in tools.test.ts).
		expect(rendered).not.toContain("Full output:");
		expect(rendered).not.toContain("Truncated:");
		expect(rendered).toContain("line-4000");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("collapses ordinary read results until expanded", () => {
		const longPath = join(process.cwd(), "OneDrive", "Desktop", "PROJECTS", "lunR", "session-manager.ts");
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: longPath, offset: 1310, limit: 80 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "hidden content\n\n[235 more lines in file. Use offset=1390 to continue.]",
					},
				],
				details: undefined,
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read session-manager.ts");
		expect(collapsed).not.toContain("OneDrive");
		expect(collapsed).not.toContain(":1310-");
		expect(collapsed).not.toContain("more lines in file");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md" },
	] as const) {
		test(`compact ${scenario.title} reads stay name-only without a range or expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(":120-329");
			expect(collapsed).not.toContain("to expand");
		});
	}
});

// lunr: TUI density — compact-by-default completed tool calls + same-tool grouping.
describe("ToolExecutionComponent density", () => {
	beforeAll(() => {
		initTheme("moon");
	});

	test("exposes the tool name for grouping adjacency checks", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-name",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.getToolName()).toBe("bash");
	});

	test("setGroupContinuation(true) removes the leading spacer and top pad", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-group",
			{ command: "echo hi" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		const defaultLines = component.render(80).length;
		component.setGroupContinuation(true);
		expect(component.render(80).length).toBe(defaultLines - 2);
		component.setGroupContinuation(false);
		expect(component.render(80).length).toBe(defaultLines);
	});

	test("consecutive compact reads sit flush with pad above the first and below the last", () => {
		const first = compactRead("tool-read-a", "resolve.ts");
		const second = compactRead("tool-read-b", "model-runtime.ts");
		const lines = renderGroupedTools(first, second);
		const firstIdx = headerIndex(lines, "read resolve.ts");
		const secondIdx = headerIndex(lines, "read model-runtime.ts");
		expect(firstIdx).toBeGreaterThan(0);
		expect(secondIdx).toBe(firstIdx + 1);
		expect(isBlank(lines[firstIdx - 1])).toBe(true);
		expect(isBlank(lines[secondIdx + 1])).toBe(true);
	});

	test("three compact reads stay flush with pad only at the group edges", () => {
		const lines = renderGroupedTools(
			compactRead("tool-read-a", "resolve.ts"),
			compactRead("tool-read-b", "model-runtime.ts"),
			compactRead("tool-read-c", "usage-service.ts"),
		);
		const a = headerIndex(lines, "read resolve.ts");
		const b = headerIndex(lines, "read model-runtime.ts");
		const c = headerIndex(lines, "read usage-service.ts");
		expect(a).toBeGreaterThan(0);
		expect(b).toBe(a + 1);
		expect(c).toBe(b + 1);
		expect(isBlank(lines[a - 1])).toBe(true);
		expect(isBlank(lines[c + 1])).toBe(true);
	});

	test("mixed read then bash keeps a blank line between headers", () => {
		const read = compactRead("tool-read-mixed", "resolve.ts");
		const bash = new ToolExecutionComponent(
			"bash",
			"tool-bash-mixed",
			{ command: "echo hi" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		bash.markExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "hi" }], details: undefined, isError: false }, false);
		const lines = renderGroupedTools(read, bash);
		const readIdx = headerIndex(lines, "read resolve.ts");
		const bashIdx = headerIndex(lines, "$ echo hi");
		expect(readIdx).toBeGreaterThanOrEqual(0);
		expect(bashIdx).toBeGreaterThan(readIdx + 1);
		expect(lines.slice(readIdx + 1, bashIdx).some(isBlank)).toBe(true);
	});

	test("a lone compact read keeps pad above and below the header", () => {
		const lines = renderGroupedTools(compactRead("tool-read-lone", "resolve.ts"));
		const idx = headerIndex(lines, "read resolve.ts");
		expect(idx).toBeGreaterThan(0);
		expect(isBlank(lines[idx - 1])).toBe(true);
		expect(isBlank(lines[idx + 1])).toBe(true);
	});

	test("finished successful bash calls render a single compact header with duration", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-compact",
			{ command: "echo line1" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "line1\nline2\nline3" }], details: undefined, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// Header carries the command and the folded-in duration…
		expect(rendered).toContain("$ echo line1");
		expect(rendered).toContain("— Took");
		// …exactly once (no separate footer), and the output preview is gone.
		expect(rendered.match(/Took/g)).toHaveLength(1);
		expect(rendered).not.toContain("line2");
	});

	test("expanded bash calls keep the full output preview", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-expanded",
			{ command: "echo line1" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "line1\nline2\nline3" }], details: undefined, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("line2");
		expect(rendered).toContain("line3");
	});

	test("errored bash calls keep the full output and Took footer", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-error",
			{ command: "echo line1" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "line1\nline2\nCommand exited with code 1" }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("line2");
		expect(rendered).not.toContain("— Took");
		expect(rendered).toContain("Took");
	});

	test("slim bash header keeps only the first line of multi-line commands", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-multiline",
			{ command: "echo one\necho two" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("$ echo one …");
		expect(rendered).not.toContain("echo two");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("echo two");
	});

	test("slim bash header drops the timeout suffix when compact", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-timeout",
			{ command: "echo hi", timeout: 30 },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		// While running, the timeout suffix is visible.
		const running = stripAnsi(component.render(120).join("\n"));
		expect(running).toContain("(timeout 30s)");

		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "hi" }], details: undefined, isError: false }, false);
		const compact = stripAnsi(component.render(120).join("\n"));
		expect(compact).not.toContain("(timeout 30s)");
	});

	test("finished successful grep calls render header-only", () => {
		const component = new ToolExecutionComponent(
			"grep",
			"tool-grep-compact",
			{ pattern: "usage" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "src/a.ts:10: usage here" }], details: undefined, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("grep");
		expect(rendered).not.toContain("usage here");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("usage here");
	});

	test("compact grep results keep a trailing truncation/limit notice", () => {
		const component = new ToolExecutionComponent(
			"grep",
			"tool-grep-notice",
			{ pattern: "usage" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "src/a.ts:10: usage here\n\n[50 matches limit reached. Use limit=100 for more, or refine pattern]",
					},
				],
				details: { matchLimitReached: 50 },
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).not.toContain("usage here");
		expect(rendered).toContain("[50 matches limit reached");
	});

	test("errored grep calls render the full result", () => {
		const component = new ToolExecutionComponent(
			"grep",
			"tool-grep-error",
			{ pattern: "usage" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "ripgrep exited with code 2" }], details: undefined, isError: true },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("ripgrep exited with code 2");
	});
});
