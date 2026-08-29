/**
 * simple-memory — a minimal one-file memory extension for pi.
 *
 * One memory file (~/.lunr/simple-memory/memory.md), one durable fact per line.
 * Loaded into the system prompt every turn while agent memory is enabled.
 * Tools: memory_add, memory_remove, memory_load.
 * Command: /memory-char-cap [n] — view or set the character cap (1..30000, default 5000).
 *
 * Loaded by pi via jiti — no build step, plain TypeScript.
 *
 * Types are declared inline (see the batxj-thinking extension for why:
 * pi-coding-agent's index.d.ts re-exports from internal .d.ts files with
 * subpath imports that fail under `tsc --noEmit index.ts`). `Type` is a
 * runtime value imported from @sinclair/typebox (a peer dependency) for tool
 * parameter schemas.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
// lunr: concrete core-module import (never the package barrel) — resolves the
// memory dir next to the lunr agent dir instead of the hardcoded ~/.pi below.
import { getAgentDir } from "../config.js";

// ---------------------------------------------------------------------------
// Paths and config
// ---------------------------------------------------------------------------
// lunr: was join(homedir(), ".pi", "simple-memory") — leaked lunr memory into a
// real pi install's ~/.pi. Now a sibling of the lunr agent dir (~/.lunr/simple-memory).
// Old files are copied over by the core startup migration (migrations.ts).
function baseDir(): string {
	return join(dirname(getAgentDir()), "simple-memory");
}

function memoryFile(): string {
	return join(baseDir(), "memory.md");
}

function configFile(): string {
	return join(baseDir(), "config.json");
}

const DEFAULT_CHAR_CAP = 5000;
const MIN_CHAR_CAP = 1;
const MAX_CHAR_CAP = 30000;

// lunr: inside lunR the cap lives in lunR settings, exposed by core on
// globalThis under Symbol.for("@lunr/memory-cap") (registered from main.ts).
// The config.json fallback below only matters when no bridge exists.
interface MemoryCapBridge {
	isEnabled(): boolean;
	getCharCap(): number;
	setCharCap(cap: number): void;
}

function getCapBridge(): MemoryCapBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/memory-cap")] as MemoryCapBridge | undefined;
}

function isMemoryEnabled(): boolean {
	return getCapBridge()?.isEnabled() ?? true;
}

function disabledResult(): ToolResult {
	return { content: [{ type: "text", text: "Agent memory is disabled in /settings." }] };
}

// ---------------------------------------------------------------------------
// Inline structural types (self-contained for `tsc --noEmit index.ts`)
// ---------------------------------------------------------------------------
interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: Record<string, unknown>;
}

interface ExtensionAPI {
	registerTool(tool: {
		name: string;
		label?: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<ToolResult> | ToolResult;
	}): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler(args: string, ctx: CommandContext): Promise<void> | void;
		},
	): void;
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: unknown,
		) =>
			| Promise<{ systemPrompt?: string } | void>
			| { systemPrompt?: string }
			| void,
	): void;
}

interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt?: string;
	systemPrompt: string;
}

interface CommandContext {
	mode: string;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(): void {
	const dir = baseDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readMemory(): string {
	const file = memoryFile();
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

function writeMemoryRaw(text: string): void {
	ensureDir();
	writeFileSync(memoryFile(), text, "utf-8");
}

// Non-empty lines, in order. Normalizes the file (drops blank lines).
function memoryLines(): string[] {
	const text = readMemory();
	if (!text.trim()) return [];
	return text.split("\n").filter((l) => l.trim().length > 0);
}

function clampCap(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_CHAR_CAP;
	n = Math.trunc(n);
	if (n < MIN_CHAR_CAP) return MIN_CHAR_CAP;
	if (n > MAX_CHAR_CAP) return MAX_CHAR_CAP;
	return n;
}

function readCap(): number {
	const bridge = getCapBridge();
	if (bridge) return clampCap(bridge.getCharCap());
	const file = configFile();
	if (!existsSync(file)) return DEFAULT_CHAR_CAP;
	try {
		const cfg = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof cfg.charCap === "number" && Number.isFinite(cfg.charCap)) {
			return clampCap(cfg.charCap);
		}
	} catch {
		// corrupt config — fall back to default
	}
	return DEFAULT_CHAR_CAP;
}

function writeCap(cap: number): void {
	const bridge = getCapBridge();
	if (bridge) {
		bridge.setCharCap(clampCap(cap));
		return;
	}
	ensureDir();
	writeFileSync(configFile(), JSON.stringify({ charCap: cap }, null, 2), "utf-8");
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

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI): void {
	// --- Inject memory into the system prompt every turn ---
	pi.on("before_agent_start", async (event) => {
		if (!isMemoryEnabled()) return;
		const mem = readMemory();
		if (!mem.trim()) return; // inject nothing when empty
		const block =
			"\n\n## Memory (durable facts; apply these; change them only with the memory tools)\n" +
			mem.trimEnd();
		return { systemPrompt: event.systemPrompt + block };
	});

	// --- memory_add ---
	pi.registerTool({
		name: "memory_add",
		label: "Memory Add",
		description: [
			"Add one durable fact about the user or their environment.",
			"Store only established facts and stable preferences, never behavior instructions, task state, transcripts, guesses, or secrets.",
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
			if (!isMemoryEnabled()) return disabledResult();
			const content = String(params.content ?? "").replace(/[\r\n]+/g, " ").trim();
			if (!content) {
				return { content: [{ type: "text", text: "memory_add: content is empty." }] };
			}
			const lines = memoryLines();
			// exact-content dedup (compare bare content, ignoring the date prefix)
			if (lines.some((l) => stripDate(l) === content)) {
				return { content: [{ type: "text", text: "Already in memory (not added)." }] };
			}
			const cap = readCap();
			const newLine = `[${todayStamp()}] ${content}`;
			const sep = lines.length > 0 ? "\n" : "";
			const prospective = lines.join("\n") + sep + newLine + "\n";
			if (prospective.length > cap) {
				return {
					content: [
						{
							type: "text",
							text: `Memory full: ${readMemory().length}/${cap} chars. Remove a memory first (memory_remove).`,
						},
					],
				};
			}
			writeMemoryRaw(prospective);
			return {
				content: [
					{ type: "text", text: `Added memory (${prospective.length}/${cap} chars): ${newLine}` },
				],
			};
		},
	});

	// --- memory_remove ---
	pi.registerTool({
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
			if (!isMemoryEnabled()) return disabledResult();
			const target = String(params.line ?? "").trim();
			if (!target) {
				return { content: [{ type: "text", text: "memory_remove: line is empty." }] };
			}
			const lines = memoryLines();
			const remaining = lines.filter((l) => l !== target);
			if (remaining.length === lines.length) {
				return { content: [{ type: "text", text: `Not found (no exact match): ${target}` }] };
			}
			writeMemoryRaw(remaining.length > 0 ? remaining.join("\n") + "\n" : "");
			return { content: [{ type: "text", text: `Removed memory: ${target}` }] };
		},
	});

	// --- memory_load ---
	pi.registerTool({
		name: "memory_load",
		label: "Memory Load",
		description: [
			"Read the current memory file and show all memories with the size/cap.",
			"Use this to inspect durable facts before adding, correcting, or removing one.",
		].join("\n"),
		parameters: Type.Object({}),
		async execute() {
			if (!isMemoryEnabled()) return disabledResult();
			const raw = readMemory();
			const cap = readCap();
			if (!raw.trim()) {
				return { content: [{ type: "text", text: `Memory is empty (0/${cap} chars).` }] };
			}
			return {
				content: [
					{ type: "text", text: `Memory (${raw.length}/${cap} chars):\n${raw.trimEnd()}` },
				],
			};
		},
	});

	// --- /memory-char-cap command ---
	pi.registerCommand("memory-char-cap", {
		description: "View or set the memory character cap (1..30000). Default 5000.",
		handler(args, ctx) {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(`Memory character cap: ${readCap()}`, "info");
				return;
			}
			const n = Number(trimmed);
			if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_CHAR_CAP || n > MAX_CHAR_CAP) {
				ctx.ui.notify(
					`Invalid cap. Must be an integer between ${MIN_CHAR_CAP} and ${MAX_CHAR_CAP}.`,
					"error",
				);
				return;
			}
			if (n < readMemory().length) {
				ctx.ui.notify(
					`Your memory file already exceeds this character cap: ${memoryFile()}`,
					"warning",
				);
				return;
			}
			writeCap(n);
			ctx.ui.notify(`Memory character cap set to ${n}.`, "info");
		},
	});
}
