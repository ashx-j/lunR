import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getDocsPath, getExamplesPath, getReadmePath } from "../src/config.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	afterEach(() => vi.useRealTimers());

	test("builds the lunR default prompt with runtime model and path values", () => {
		const cwd = "C:\\work\\project";
		const prompt = buildSystemPrompt({
			modelSlug: "openai/gpt-5.6",
			contextFiles: [],
			skills: [],
			cwd,
		});

		expect(prompt).toContain(
			"You are an expert coding assistant currently running openai/gpt-5.6, operating inside lunR, a coding agent harness.",
		);
		expect(prompt).toContain("- Working directory: C:/work/project");
		expect(prompt).toContain("Behavior guidelines:");
		expect(prompt).toContain("Memory stores established, durable facts and stable preferences.");
		expect(prompt).toContain("should be click-to-copy");
		expect(prompt).toContain("fenced Markdown block with the info string `lunr-copy`");
		expect(prompt).toContain("Use a longer backtick or tilde fence when the payload contains fenced code.");
		expect(prompt).toContain(
			"Resume a subagent only when its work is unfinished or the next task genuinely needs the context it built up.",
		);
		expect(prompt).toContain("inspect with `lunr gateway status` or `lunr gateway doctor`");
		expect(prompt).toContain("configure with `lunr gateway setup`");
		expect(prompt).toContain("send `/whoami` or a normal message to the bot");
		expect(prompt).toContain("there is no arbitrary outbound send command");
		expect(prompt).toContain("Keep bot tokens out of commands and output.");
		expect(prompt).toContain(`${getDocsPath()}/features.md`);
		expect(prompt).toContain("Never modify this tree, including through shell commands.");
		expect(prompt).not.toContain("behavior.md");
		expect(prompt).toContain("Guidelines:");
		expect(prompt).toContain("lunR documentation");
		expect(prompt).toContain(`- README: ${getReadmePath()}`);
		expect(prompt).toContain(`- Documentation: ${getDocsPath()}`);
		expect(prompt).toContain(`- Examples: ${getExamplesPath()}`);
	});

	test("keeps delegation guidance on by default and requires explicit requests when off", () => {
		const options = { cwd: process.cwd(), contextFiles: [], skills: [] };
		const defaultPrompt = buildSystemPrompt(options);
		const directPrompt = buildSystemPrompt({ ...options, automaticSubagentDelegation: false });

		expect(defaultPrompt).toContain("Use subagents for independent parallel work");
		expect(defaultPrompt).toContain("Orchestrate subagents with intent!");
		expect(directPrompt).toContain(
			"Launch subagents only when the user specifically instructs you to delegate work.",
		);
		expect(directPrompt).not.toContain("Use subagents for independent parallel work");
		expect(directPrompt).not.toContain("Orchestrate subagents with intent!");
		expect(directPrompt).toContain("Resume a subagent only when its work is unfinished");
		expect(
			buildSystemPrompt({ ...options, customPrompt: "Custom", automaticSubagentDelegation: false }),
		).not.toContain("Launch subagents only");
	});

	test("includes todo guidance only while the todo tool is active", () => {
		const withTodos = buildSystemPrompt({
			selectedTools: ["read", "todo"],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		const withoutTodos = buildSystemPrompt({
			selectedTools: ["read"],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(withTodos).toContain("Use todo for meaningful multi-step work.");
		expect(withoutTodos).not.toContain("Use todo for meaningful multi-step work.");
	});

	test("sends each tool's guideline only while that tool is active", () => {
		const options = { cwd: process.cwd(), contextFiles: [], skills: [] };
		const lines: Record<string, string> = {
			read: "Use read to examine files",
			bash: "For gateway work",
			subagent: "Resume a subagent only",
			intercom: "Use intercom to coordinate",
			ast_search: "Use ast_search",
			memory_add: "Memory stores established",
			web_search: "Use web search",
			mcp: "Use MCP only",
		};
		const none = buildSystemPrompt({ ...options, selectedTools: [] });
		for (const [tool, line] of Object.entries(lines)) {
			expect(none, tool).not.toContain(line);
			expect(buildSystemPrompt({ ...options, selectedTools: [tool] }), tool).toContain(line);
		}
	});

	test("states the working directory, git state, OS and the date the session started", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 2, 7, 23, 30));
		const root = mkdtempSync(join(tmpdir(), "lunr-prompt-env-"));
		try {
			const repo = join(root, "repo");
			mkdirSync(join(repo, ".git", "x"), { recursive: true });
			mkdirSync(join(repo, "src"));
			const inRepo = buildSystemPrompt({ cwd: join(repo, "src"), contextFiles: [], skills: [] });
			expect(inRepo).toMatch(
				/\n\nEnvironment:\n- Working directory: .*\/repo\/src\n- Git repository: yes\n- OS: .+\n- Session started: 2026-03-07$/,
			);
			expect(buildSystemPrompt({ cwd: root, contextFiles: [], skills: [] })).toContain("- Git repository: no");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("leaves cron guidance to the cron tool description", () => {
		// Loading cron through load_tools must not change the system prompt.
		const options = { cwd: process.cwd(), contextFiles: [], skills: [] };
		expect(buildSystemPrompt({ ...options, selectedTools: ["read", "cron"] })).toBe(
			buildSystemPrompt({ ...options, selectedTools: ["read"] }),
		);
	});

	test("does not duplicate API tool definitions or tool prompt metadata", () => {
		const prompt = buildSystemPrompt({
			modelSlug: "test/model",
			selectedTools: ["read", "dynamic_tool"],
			toolSnippets: { dynamic_tool: "Run dynamic test behavior" },
			promptGuidelines: ["Use dynamic_tool for project summaries."],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("Run dynamic test behavior");
		expect(prompt).not.toContain("Use dynamic_tool for project summaries.");
	});

	test("uses an explicit fallback when no model is selected", () => {
		const prompt = buildSystemPrompt({
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("currently running no model selected,");
	});

	test("keeps custom system prompt replacement behavior unchanged", () => {
		const cwd = mkdtempSync(join(tmpdir(), "lunr-custom-prompt-"));
		try {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom prompt",
				modelSlug: "test/model",
				appendSystemPrompt: "Appended instructions",
				contextFiles: [],
				skills: [],
				cwd,
			});

			expect(prompt.startsWith("Custom prompt\n\nAppended instructions\n\nEnvironment:\n")).toBe(true);
			expect(prompt).toContain(`- Working directory: ${cwd.replace(/\\/g, "/")}\n- Git repository: no\n`);
			expect(prompt).not.toContain("test/model");
			expect(prompt).not.toContain("lunr-copy");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
