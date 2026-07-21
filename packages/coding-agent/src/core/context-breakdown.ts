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
}

export interface ContextBreakdown {
	/** System prompt, including appended project context files (AGENTS.md etc.). */
	systemPrompt: number;
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
}

const CHARS_PER_TOKEN = 4;

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
	const systemPrompt = Math.ceil(input.systemPrompt.length / CHARS_PER_TOKEN);
	const toolDefinitions = estimateToolDefinitionTokens(input.tools);

	let user = 0;
	let assistantText = 0;
	let thinking = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let summaries = 0;

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
				break;
			}
			case "user":
			case "custom":
				user += estimateTokens(message);
				break;
			case "toolResult":
			case "bashExecution":
				toolResults += estimateTokens(message);
				break;
			case "branchSummary":
			case "compactionSummary":
				summaries += estimateTokens(message);
				break;
		}
	}

	const total = systemPrompt + toolDefinitions + user + assistantText + thinking + toolCalls + toolResults + summaries;
	return {
		systemPrompt,
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
	};
}
