/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Current model in provider/id form. */
	modelSlug?: string;
	/** Active tools; used to decide whether read-dependent skill metadata is visible. */
	selectedTools?: string[];
	/** Legacy extension metadata retained for API compatibility; tool definitions are sent separately. */
	toolSnippets?: Record<string, string>;
	/** Legacy extension metadata retained for API compatibility; not appended to the default prompt. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the base system prompt and append configured context. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		modelSlug,
		selectedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const currentModel = modelSlug?.trim() || "no model selected";
	const hasRead = !selectedTools || selectedTools.includes("read");

	let prompt = `You are an expert coding assistant currently running ''${currentModel}'', operating inside lunR, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Current working directory: ''${promptCwd}''

Behavior guidelines:
- Default to writing no comments. Only add one if the why is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, something that would surprise the reader. If removing the comment wouldn't confuse a future reader, don't write it.
- Keep comments up to date! When making changes, it's important to keep things in sync. An outdated comment is worse than no comment at all.
- Carefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding.
- Orchestrate subagents with intent! Do not spawn subagents or a multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks. Use subagents as a tool when there is genuine benefit to it or the user explicitly asks for it.
- When several agents work in parallel, state file ownership up front so they do not collide.
- Tests are good! Endless smoke tests, regressions tests for feature deletions, etc, much less good. Tests should be focused, not slop.
- Prefer editing existing files to creating new ones.
- Only use emojis if the user explicitly requests it.
- Never exfil private data on public platforms like github or any other services under any circumstances.


Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Use todo for meaningful multi-step work. Every update must send the complete list, with exactly one item in progress at a time.
- Use subagents for independent parallel work, specialist analysis, or substantial research. Subagents start with fresh sessions. Use intercom instead to coordinate with an existing lunR session.
- Use ast_search for structural code matches.
- Use cron only when the user asks to schedule or manage unattended prompts.
- Memory stores established, durable facts and stable preferences. Do not store behavior instructions, transient task details, transcripts, guesses, or secrets. Change memory only with the memory tools.
- ~/.lunr/agent/agents/ contains optional global and per-model AGENTS.md instructions written by the user. Never modify this tree, including through shell commands.
- Use web search when information is current, uncertain, externally referenced, or research-heavy, and cite the sources used.
- Use MCP only for capabilities exposed by configured MCP servers. Call native lunR tools directly.


lunR documentation (read only when the user asks about lunR itself, or the task concerns lunR itself, its SDK, extensions, themes, skills, or TUI):
- README: ${readmePath}
- Documentation: ${docsPath}
- Examples: ${examplesPath}
- Always read lunR .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	return prompt;
}
