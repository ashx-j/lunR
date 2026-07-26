/**
 * Behavior — user-defined behavior rules (absorbed from the former
 * lunr-behavior baked-in extension into core).
 *
 * One behavior file (~/.lunr/agent/behavior.md — honors PI_CODING_AGENT_DIR via
 * getAgentDir()), one rule per line, injected into the system prompt on every
 * agent start (see agent-session.ts). Shares the `memoryCharCap` setting with
 * the memory file.
 *
 * Unlike memory, behavior lines do NOT get a date prefix (plain append, dedup
 * on exact line).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getAgentDir } from "../config.ts";
import { defineTool, type ToolDefinition } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

export function getBehaviorFilePath(): string {
	return join(getAgentDir(), "behavior.md");
}

const HEADER_COMMENT = "<!-- lunR behavior rules — one rule per line. Edit freely or use the behavior tools. -->\n";

function readBehavior(): string {
	const file = getBehaviorFilePath();
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

function writeBehaviorRaw(text: string): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(getBehaviorFilePath(), text, "utf-8");
}

function behaviorLines(): string[] {
	const text = readBehavior();
	if (!text.trim()) return [];
	return text.split("\n").filter((l) => l.trim().length > 0);
}

// Strip the header comment from text meant for the system prompt or display.
function stripHeader(content: string): string {
	return content
		.split("\n")
		.filter((l) => !l.startsWith("<!--"))
		.join("\n")
		.trimEnd();
}

/**
 * System-prompt block for the current behavior file, or "" when empty.
 * Fresh read on every call — agent-session.ts appends this on every agent start.
 */
export function getBehaviorSystemPromptBlock(): string {
	const content = readBehavior();
	if (!content.trim()) return "";
	const body = stripHeader(content);
	if (!body) return "";
	return "\n\n## Behavior rules (user-defined; follow these; change them with the behavior tools)\n" + body;
}

export function createBehaviorTools(settingsManager: SettingsManager): ToolDefinition[] {
	return [
		defineTool({
			name: "behavior_add",
			label: "Behavior Add",
			description: [
				"Add one behavior rule line to the behavior file (~/.lunr/agent/behavior.md).",
				"Each rule is a single line; no date prefix is added.",
				"Refuses if the line already exists (exact match) or if the file is at the character cap.",
			].join("\n"),
			parameters: Type.Object({
				content: Type.String({
					description: "The behavior rule text (one line).",
				}),
			}),
			async execute(_id, params) {
				const line = String(params.content ?? "")
					.replace(/[\r\n]+/g, " ")
					.trim();
				if (!line) {
					return textResult("behavior_add: content is empty.");
				}
				const lines = behaviorLines();
				if (lines.some((l) => l === line)) {
					return textResult("Already in behavior file (not added).");
				}
				const cap = settingsManager.getMemoryCharCap();
				const existing = readBehavior();
				const baseText = existing.startsWith(HEADER_COMMENT) ? existing.slice(HEADER_COMMENT.length) : existing;
				const sep = baseText.trim().length > 0 ? "\n" : "";
				const prospective = HEADER_COMMENT + baseText.trimEnd() + sep + line + "\n";
				if (prospective.length > cap) {
					return textResult(
						`Behavior file full: ${existing.length}/${cap} chars. Remove a rule first (behavior_remove).`,
					);
				}
				writeBehaviorRaw(prospective);
				return textResult(`Added behavior rule (${prospective.length}/${cap} chars): ${line}`);
			},
		}),

		defineTool({
			name: "behavior_remove",
			label: "Behavior Remove",
			description: [
				"Remove one behavior rule by its exact line text, as shown by behavior_load.",
				"Deletes only an exact, full-line match.",
				"Returns 'not found' if no line matches exactly.",
			].join("\n"),
			parameters: Type.Object({
				line: Type.String({
					description: "The exact behavior rule line to remove (verbatim).",
				}),
			}),
			async execute(_id, params) {
				const target = String(params.line ?? "").trim();
				if (!target) {
					return textResult("behavior_remove: line is empty.");
				}
				const lines = behaviorLines();
				const remaining = lines.filter((l) => l !== target);
				if (remaining.length === lines.length) {
					return textResult(`Not found (no exact match): ${target}`);
				}
				writeBehaviorRaw(HEADER_COMMENT + (remaining.length > 0 ? remaining.join("\n") + "\n" : ""));
				return textResult(`Removed behavior rule: ${target}`);
			},
		}),

		defineTool({
			name: "behavior_load",
			label: "Behavior Load",
			description: [
				"Read the current behavior file and show all rules with the size/cap.",
				"Use this to re-read after editing the file by hand, or to inspect it.",
			].join("\n"),
			parameters: Type.Object({}),
			async execute() {
				const raw = readBehavior();
				const cap = settingsManager.getMemoryCharCap();
				if (!raw.trim()) {
					return textResult(`Behavior file is empty (0/${cap} chars).`);
				}
				return textResult(`Behavior (${raw.length}/${cap} chars):\n${stripHeader(raw)}`);
			},
		}),
	];
}
