import { describe, expect, test } from "vitest";
import { getDocsPath, getExamplesPath, getReadmePath } from "../src/config.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("builds the lunR default prompt with runtime model and path values", () => {
		const cwd = "C:\\work\\project";
		const prompt = buildSystemPrompt({
			modelSlug: "openai/gpt-5.6",
			selectedTools: ["read", "bash", "edit", "write"],
			contextFiles: [],
			skills: [],
			cwd,
		});

		expect(prompt).toContain(
			"You are an expert coding assistant currently running ''openai/gpt-5.6'', operating inside lunR, a coding agent harness.",
		);
		expect(prompt).toContain("Current working directory: ''C:/work/project''");
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

		expect(prompt).toContain("currently running ''no model selected''");
	});

	test("keeps custom system prompt replacement behavior unchanged", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "Custom prompt",
			modelSlug: "test/model",
			appendSystemPrompt: "Appended instructions",
			contextFiles: [],
			skills: [],
			cwd: "C:\\custom\\cwd",
		});

		expect(prompt).toBe("Custom prompt\n\nAppended instructions\nCurrent working directory: C:/custom/cwd");
		expect(prompt).not.toContain("test/model");
		expect(prompt).not.toContain("lunr-copy");
	});
});
