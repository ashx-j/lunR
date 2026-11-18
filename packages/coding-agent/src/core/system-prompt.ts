/**
 * System prompt construction and project context loading
 */

import { existsSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Current model in provider/id form. */
	modelSlug?: string;
	/** Whether the default prompt encourages autonomous delegation. */
	automaticSubagentDelegation?: boolean;
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
		automaticSubagentDelegation = true,
		selectedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;

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

		prompt += environmentBlock(cwd);

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const currentModel = modelSlug?.trim() || "no model selected";
	const has = (tool: string) => !selectedTools || selectedTools.includes(tool);
	const hasRead = has("read");
	const delegationBehavior = automaticSubagentDelegation
		? "- Orchestrate subagents with intent! Do not spawn subagents or a multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks. Use subagents as a tool when there is genuine benefit to it or the user explicitly asks for it."
		: "- Work on tasks directly. Launch subagents only when the user specifically instructs you to delegate work.";
	// A tool's guideline goes out only when the session has that tool.
	const guidelines = [
		has("bash") && "Use bash for file operations like ls, rg, find",
		hasRead && "Use read to examine files instead of cat or sed.",
		has("todo") &&
			"Use todo for meaningful multi-step work. Every update must send the complete list, with exactly one item in progress at a time.",
		automaticSubagentDelegation &&
			has("subagent") &&
			"Use subagents for independent parallel work, specialist analysis, or substantial research. Subagents start with fresh sessions.",
		has("intercom") && "Use intercom to coordinate with an existing lunR session.",
		has("subagent") &&
			"Resume a subagent only when its work is unfinished or the next task genuinely needs the context it built up. Otherwise launch a new subagent.",
		has("ast_search") && "Use ast_search for structural code matches.",
		has("cron") && "Use cron only when the user asks to schedule or manage unattended prompts.",
		has("bash") &&
			`For gateway work, inspect with \`lunr gateway status\` or \`lunr gateway doctor\`, configure with \`lunr gateway setup\`, and run \`lunr gateway start\` or \`lunr gateway stop\` only with user approval. Test by asking the user to send \`/whoami\` or a normal message to the bot; there is no arbitrary outbound send command. Keep bot tokens out of commands and output. See ${docsPath}/features.md for pairing, logs, and service details.`,
		has("memory_add") &&
			"Memory stores established, durable facts and stable preferences. Do not store behavior instructions, transient task details, transcripts, guesses, or secrets. Change memory only with the memory tools.",
		"~/.lunr/agent/agents/ contains optional global and per-model AGENTS.md instructions written by the user. Never modify this tree, including through shell commands.",
		has("web_search") &&
			"Use web search when information is current, uncertain, externally referenced, or research-heavy, and cite the sources used.",
		has("mcp") && "Use MCP only for capabilities exposed by configured MCP servers. Call native lunR tools directly.",
	]
		.filter((line) => typeof line === "string")
		.map((line) => `- ${line}`)
		.join("\n");

	let prompt = `You are an expert coding assistant currently running ${currentModel}, operating inside lunR, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Behavior guidelines:
- Default to writing no comments. Only add one if the why is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, something that would surprise the reader. If removing the comment wouldn't confuse a future reader, don't write it.
- Keep comments up to date! When making changes, it's important to keep things in sync. An outdated comment is worse than no comment at all.
- Carefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding.
${delegationBehavior}
- When several agents work in parallel, state file ownership up front so they do not collide.
- Tests are good! Endless smoke tests, regressions tests for feature deletions, etc, much less good. Tests should be focused, not slop.
- Prefer editing existing files to creating new ones.
- When a reusable excerpt, prompt, or code fragment should be click-to-copy, wrap only that payload in a fenced Markdown block with the info string \`lunr-copy\`. Keep explanation outside the block. Use a longer backtick or tilde fence when the payload contains fenced code.
- Only use emojis if the user explicitly requests it.
- Never exfil private data on public platforms like github or any other services under any circumstances.


Guidelines:
${guidelines}


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

	prompt += environmentBlock(cwd);

	return prompt;
}

/**
 * Facts the model would otherwise spend a tool call on. The prompt is rebuilt only on a model, tool
 * or resource change or a reload, so the date is the one the session started on and adds no cache
 * misses inside a session.
 */
function environmentBlock(cwd: string): string {
	const now = new Date();
	const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
	return `\n\nEnvironment:
- Working directory: ${cwd.replace(/\\/g, "/")}
- Git repository: ${isInGitRepo(cwd) ? "yes" : "no"}
- OS: ${osName()}
- Session started: ${date}`;
}

/** macOS and Windows report kernel versions (Darwin 25 is macOS 26), so only Linux gets one. */
function osName(): string {
	if (process.platform === "darwin") return "macOS";
	if (process.platform === "win32") return "Windows";
	return process.platform === "linux" ? `Linux ${release()}` : process.platform;
}

function isInGitRepo(cwd: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return true;
		if (dirname(dir) === dir) return false;
	}
}
