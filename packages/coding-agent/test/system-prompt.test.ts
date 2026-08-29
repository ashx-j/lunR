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
		expect(prompt).toContain("Never modify it, including through shell commands.");
		expect(prompt).not.toContain("behavior.md");
		expect(prompt).toContain("Guidelines:");
		expect(prompt).toContain("lunR documentation");
		expect(prompt).toContain(`- README: ${getReadmePath()}`);
		expect(prompt).toContain(`- Documentation: ${getDocsPath()}`);
		expect(prompt).toContain(`- Examples: ${getExamplesPath()}`);
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
	});
});
