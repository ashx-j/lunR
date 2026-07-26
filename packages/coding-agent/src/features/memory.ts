/**
 * Memory — durable facts about the user (absorbed from the former
 * simple-pi-memory baked-in extension into core).
 *
 * One memory file (~/.lunr/agent/memory.md — honors PI_CODING_AGENT_DIR via
 * getAgentDir()), one memory per line, injected into the system prompt on every
 * agent start (see agent-session.ts). The character cap lives in lunR settings
 * (SettingsManager.getMemoryCharCap) — the legacy
 * ~/.pi/simple-memory/config.json fallback was dropped.
 *
 * lunr: one-time migration — on first read/write, if the new file does not
 * exist but the legacy ~/.pi/simple-memory/memory.md does, it is copied over
 * (the legacy file is left in place).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getAgentDir } from "../config.ts";
import { defineTool, type ToolDefinition } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

const LEGACY_MEMORY_FILE = join(homedir(), ".pi", "simple-memory", "memory.md");

export function getMemoryFilePath(): string {
	return join(getAgentDir(), "memory.md");
}

let migrationChecked = false;

function ensureMigrated(): void {
	if (migrationChecked) return;
	migrationChecked = true;
	const target = getMemoryFilePath();
	if (existsSync(target) || !existsSync(LEGACY_MEMORY_FILE)) return;
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		copyFileSync(LEGACY_MEMORY_FILE, target);
	} catch {
		// Best effort — a failed migration just starts with an empty memory file.
	}
}

function readMemory(): string {
	ensureMigrated();
	const file = getMemoryFilePath();
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

function writeMemoryRaw(text: string): void {
	ensureMigrated();
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(getMemoryFilePath(), text, "utf-8");
}

// Non-empty lines, in order. Normalizes the file (drops blank lines).
function memoryLines(): string[] {
	const text = readMemory();
	if (!text.trim()) return [];
	return text.split("\n").filter((l) => l.trim().length > 0);
}

/** Current memory file size in characters (0 when missing). */
export function getMemoryFileSize(): number {
	return readMemory().length;
}

function todayStamp(): string {
	const d = new Date();
	const p = (x: number) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Strip a leading "[YYYY-MM-DD] " date prefix so dedup compares bare content.
function stripDate(line: string): string {
	return line.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "");
}

/**
 * System-prompt block for the current memory file, or "" when empty.
 * Fresh read on every call — agent-session.ts appends this on every agent start.
 */
export function getMemorySystemPromptBlock(): string {
	const mem = readMemory();
	if (!mem.trim()) return "";
	return (
		"\n\n## Memory (durable facts about the user; apply these; change them with the memory tools)\n" + mem.trimEnd()
	);
}

export function createMemoryTools(settingsManager: SettingsManager): ToolDefinition[] {
	return [
		defineTool({
			name: "memory_add",
			label: "Memory Add",
			description: [
				"Add one durable memory about the user (a fact, preference, or decision).",
				"Each memory is a single line; a [YYYY-MM-DD] date prefix is added automatically.",
				"An optional #tag improves readability (e.g. #preference).",
				"Refuses if the content already exists (exact match) or if the file is at the character cap.",
			].join("\n"),
			parameters: Type.Object({
				content: Type.String({
					description: "The memory text (one line). You may include a #tag.",
				}),
			}),
			async execute(_id, params) {
				const content = String(params.content ?? "")
					.replace(/[\r\n]+/g, " ")
					.trim();
				if (!content) {
					return textResult("memory_add: content is empty.");
				}
				const lines = memoryLines();
				// exact-content dedup (compare bare content, ignoring the date prefix)
				if (lines.some((l) => stripDate(l) === content)) {
					return textResult("Already in memory (not added).");
				}
				const cap = settingsManager.getMemoryCharCap();
				const newLine = `[${todayStamp()}] ${content}`;
				const sep = lines.length > 0 ? "\n" : "";
				const prospective = lines.join("\n") + sep + newLine + "\n";
				if (prospective.length > cap) {
					return textResult(
						`Memory full: ${readMemory().length}/${cap} chars. Remove a memory first (memory_remove).`,
					);
				}
				writeMemoryRaw(prospective);
				return textResult(`Added memory (${prospective.length}/${cap} chars): ${newLine}`);
			},
		}),

		defineTool({
			name: "memory_remove",
			label: "Memory Remove",
			description: [
				"Remove one memory by its exact line text, as shown by memory_load.",
				"Deletes only an exact, full-line match (including the date prefix).",
				"Returns 'not found' if no line matches exactly.",
			].join("\n"),
			parameters: Type.Object({
				line: Type.String({
					description: "The exact memory line to remove (verbatim, including the date prefix).",
				}),
			}),
			async execute(_id, params) {
				const target = String(params.line ?? "").trim();
				if (!target) {
					return textResult("memory_remove: line is empty.");
				}
				const lines = memoryLines();
				const remaining = lines.filter((l) => l !== target);
				if (remaining.length === lines.length) {
					return textResult(`Not found (no exact match): ${target}`);
				}
				writeMemoryRaw(remaining.length > 0 ? remaining.join("\n") + "\n" : "");
				return textResult(`Removed memory: ${target}`);
			},
		}),

		defineTool({
			name: "memory_load",
			label: "Memory Load",
			description: [
				"Read the current memory file and show all memories with the size/cap.",
				"Use this to re-read memory after editing the file by hand, or to inspect it.",
			].join("\n"),
			parameters: Type.Object({}),
			async execute() {
				const raw = readMemory();
				const cap = settingsManager.getMemoryCharCap();
				if (!raw.trim()) {
					return textResult(`Memory is empty (0/${cap} chars).`);
				}
				return textResult(`Memory (${raw.length}/${cap} chars):\n${raw.trimEnd()}`);
			},
		}),
	];
}
