/**
 * lunr: Context window breakdown estimation for the /context command.
 *
 * Pure functions that estimate (chars/4, same heuristic as `estimateTokens` in
 * compaction.ts) what consumes the model's context window: the system prompt
 * (project context files are baked into it), the registered tool definitions,
 * and the live session messages split into user / assistant text / thinking /
 * tool calls / tool results / summaries.
 *
 * Pass the same message list the context actually contains (post-compaction,
 * that is `AgentSession.messages`) so the breakdown matches reality.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "./compaction/index.ts";

export interface ContextBreakdownTool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface ContextBreakdownInput {
	systemPrompt: string;
	tools: ReadonlyArray<ContextBreakdownTool>;
	messages: ReadonlyArray<AgentMessage>;
	contextWindow: number;
	/** Absolute path of the user-level AGENTS.md, used only to distinguish its UI label. */
	globalAgentsPath?: string;
}

export interface ContextFileBreakdown {
	/** Display label for the context file (AGENTS.md, Global AGENTS.md, CLAUDE.md, …). */
	label: string;
	/** Path from the <project_instructions path="…"> wrapper, when present. */
	path?: string;
	tokens: number;
}

export interface ContextBreakdown {
	/** System prompt minus <project_context> and the skills block. */
	systemPrompt: number;
	/** Each AGENTS.md / context file from <project_instructions>. */
	contextFiles: ContextFileBreakdown[];
	/** formatSkillsForPrompt section, if present. */
	skills: number;
	/** Serialized tool schemas (name + description + JSON parameter schema). */
	toolDefinitions: number;
	/** User and extension ("custom") messages. */
	user: number;
	/** Assistant text blocks. */
	assistantText: number;
	/** Assistant thinking blocks. */
	thinking: number;
	/** Assistant tool call blocks (name + serialized arguments). */
	toolCalls: number;
	/** Tool result messages and bash execution output. */
	toolResults: number;
	/** Compaction and branch summaries. */
	summaries: number;
	/** Sum of all categories above. */
	total: number;
	contextWindow: number;
	/** max(0, contextWindow - total) */
	free: number;
	/** Per-category message counts (not token counts). */
	counts: {
		user: number;
		assistantText: number;
		thinking: number;
		toolCalls: number;
		toolResults: number;
		summaries: number;
	};
}

const CHARS_PER_TOKEN = 4;
const PROJECT_CONTEXT_RE = /<project_context>[\s\S]*?<\/project_context>/;
const PROJECT_INSTRUCTIONS_RE = /<project_instructions(?:\s+path="([^"]*)")?>([\s\S]*?)<\/project_instructions>/g;
const SKILLS_BLOCK_RE =
	/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*<\/available_skills>/;

function estimateChars(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contextFileLabel(filePath: string | undefined, globalAgentsPath: string | undefined): string {
	if (!filePath) return "AGENTS.md";
	const normalized = filePath.replace(/\\/g, "/");
	if (globalAgentsPath && normalized.toLowerCase() === globalAgentsPath.replace(/\\/g, "/").toLowerCase()) {
		return "Global AGENTS.md";
	}
	const slash = normalized.lastIndexOf("/");
	return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/** Split a live system prompt into base / context-file / skills parts. */
export function splitSystemPromptSections(systemPrompt: string): {
	base: string;
	contextFiles: Array<{ path?: string; content: string }>;
	skills: string;
} {
	let remaining = systemPrompt;
	const contextFiles: Array<{ path?: string; content: string }> = [];
	const contextMatch = remaining.match(PROJECT_CONTEXT_RE);
	if (contextMatch) {
		const block = contextMatch[0];
		PROJECT_INSTRUCTIONS_RE.lastIndex = 0;
		for (const match of block.matchAll(PROJECT_INSTRUCTIONS_RE)) {
			contextFiles.push({
				path: match[1],
				content: match[2] ?? "",
			});
		}
		remaining = remaining.replace(block, "");
	}
	let skills = "";
	const skillsMatch = remaining.match(SKILLS_BLOCK_RE);
	if (skillsMatch) {
		skills = skillsMatch[0];
		remaining = remaining.replace(skills, "");
	}
	return { base: remaining, contextFiles, skills };
}

/**
 * Estimate the token cost of the tool definitions sent to the model.
 * The wire format is roughly `{ name, description, parameters(JSON schema) }` per tool.
 */
export function estimateToolDefinitionTokens(tools: ReadonlyArray<ContextBreakdownTool>): number {
	let chars = 0;
	for (const tool of tools) {
		chars += tool.name.length + tool.description.length;
		try {
			const schema = JSON.stringify(tool.parameters);
			if (schema) chars += schema.length;
		} catch {
			// Unserializable schema — skip rather than fail the whole breakdown.
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Compute the estimated context window breakdown.
 * All numbers are chars/4 estimates, matching `estimateTokens`.
 */
export function computeContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
	const sections = splitSystemPromptSections(input.systemPrompt);
	const systemPrompt = estimateChars(sections.base);
	const contextFiles = sections.contextFiles.map((file) => ({
		label: contextFileLabel(file.path, input.globalAgentsPath),
		path: file.path,
		tokens: estimateChars(file.content),
	}));
	const skills = estimateChars(sections.skills);
	const toolDefinitions = estimateToolDefinitionTokens(input.tools);

	let user = 0;
	let assistantText = 0;
	let thinking = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let summaries = 0;

	const counts = {
		user: 0,
		assistantText: 0,
		thinking: 0,
		toolCalls: 0,
		toolResults: 0,
		summaries: 0,
	};

	for (const message of input.messages) {
		switch (message.role) {
			case "assistant": {
				let textChars = 0;
				let thinkingChars = 0;
				let toolCallChars = 0;
				for (const block of (message as AssistantMessage).content) {
					if (block.type === "text") {
						textChars += block.text.length;
					} else if (block.type === "thinking") {
						thinkingChars += block.thinking.length;
					} else if (block.type === "toolCall") {
						toolCallChars += block.name.length + JSON.stringify(block.arguments).length;
					}
				}
				assistantText += Math.ceil(textChars / CHARS_PER_TOKEN);
				thinking += Math.ceil(thinkingChars / CHARS_PER_TOKEN);
				toolCalls += Math.ceil(toolCallChars / CHARS_PER_TOKEN);
				if (textChars > 0) counts.assistantText++;
				if (thinkingChars > 0) counts.thinking++;
				if (toolCallChars > 0) counts.toolCalls++;
				break;
			}
			case "user":
			case "custom":
				user += estimateTokens(message);
				counts.user++;
				break;
			case "toolResult":
			case "bashExecution":
				toolResults += estimateTokens(message);
				counts.toolResults++;
				break;
			case "branchSummary":
			case "compactionSummary":
				summaries += estimateTokens(message);
				counts.summaries++;
				break;
		}
	}

	const contextFileTokens = contextFiles.reduce((sum, file) => sum + file.tokens, 0);
	const total =
		systemPrompt +
		contextFileTokens +
		skills +
		toolDefinitions +
		user +
		assistantText +
		thinking +
		toolCalls +
		toolResults +
		summaries;
	return {
		systemPrompt,
		contextFiles,
		skills,
		toolDefinitions,
		user,
		assistantText,
		thinking,
		toolCalls,
		toolResults,
		summaries,
		total,
		contextWindow: input.contextWindow,
		free: Math.max(0, input.contextWindow - total),
		counts,
	};
}
