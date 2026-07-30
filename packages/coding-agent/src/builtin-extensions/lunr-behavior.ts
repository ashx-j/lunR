// @ts-nocheck
/**
 * lunr-behavior — user-defined behavior rules file (~/.lunr/agent/behavior.md).
 *
 * Mirrors simple-pi-memory: one file, injected into the system prompt every
 * turn (before_agent_start), shares the existing `memoryCharCap` setting via
 * the `@lunr/memory-cap` bridge. Tools: behavior_add, behavior_remove,
 * behavior_load.
 *
 * Unlike memory, behavior lines do NOT get a date prefix (plain append, dedup
 * on exact line). The file lives at ~/.lunr/agent/behavior.md (honors
 * PI_CODING_AGENT_DIR like ashxj-thinking does — NOT ~/.pi).
 *
 * Loaded by lunR via jiti — no build step, plain TypeScript. `// @ts-nocheck`
 * because the extension API types are declared inline (see simple-pi-memory).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function behaviorDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		const home = homedir();
		const expanded =
			envDir === "~"
				? home
				: envDir.startsWith("~/") || (process.platform === "win32" && envDir.startsWith("~\\"))
					? join(home, envDir.slice(2))
					: envDir;
		return expanded;
	}
	return join(homedir(), ".lunr", "agent");
}

function behaviorFile(): string {
	return join(behaviorDir(), "behavior.md");
}

// ---------------------------------------------------------------------------
// memory-cap bridge (shared with simple-pi-memory)
// ---------------------------------------------------------------------------
interface MemoryCapBridge {
	getCharCap(): number;
	setCharCap(cap: number): void;
}

function getCapBridge(): MemoryCapBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/memory-cap")] as MemoryCapBridge | undefined;
}

const DEFAULT_CHAR_CAP = 5000;

function readCap(): number {
	const bridge = getCapBridge();
	if (bridge) return bridge.getCharCap();
	return DEFAULT_CHAR_CAP;
}

// ---------------------------------------------------------------------------
// Inline structural types
// ---------------------------------------------------------------------------
interface ToolResult {
	content: { type: "text"; text: string }[];
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
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: unknown,
		) => Promise<{ systemPrompt?: string } | void> | { systemPrompt?: string } | void,
	): void;
}

interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt?: string;
	systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(): void {
	const dir = behaviorDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readBehavior(): string {
	const file = behaviorFile();
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

function writeBehaviorRaw(text: string): void {
	ensureDir();
	writeFileSync(behaviorFile(), text, "utf-8");
}

function behaviorLines(): string[] {
	const text = readBehavior();
	if (!text.trim()) return [];
	return text.split("\n").filter((l) => l.trim().length > 0);
}

const HEADER_COMMENT =
	"<!-- lunR behavior rules — one rule per line. Edit freely or use the behavior tools. -->\n";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI): void {
	// --- Inject behavior rules into the system prompt every turn ---
	pi.on("before_agent_start", async (event) => {
		const content = readBehavior();
		if (!content.trim()) return; // inject nothing when empty
		// Strip the header comment from the injected text
		const body = content
			.split("\n")
			.filter((l) => !l.startsWith("<!--"))
			.join("\n")
			.trimEnd();
		if (!body) return;
		const block =
			"\n\n## Behavior rules (user-defined; follow these; change them with the behavior tools)\n" + body;
		return { systemPrompt: event.systemPrompt + block };
	});

	// --- behavior_add ---
	pi.registerTool({
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
			const line = String(params.content ?? "").replace(/[\r\n]+/g, " ").trim();
			if (!line) {
				return { content: [{ type: "text", text: "behavior_add: content is empty." }] };
			}
			const lines = behaviorLines();
			if (lines.some((l) => l === line)) {
				return { content: [{ type: "text", text: "Already in behavior file (not added)." }] };
			}
			const cap = readCap();
			const existing = readBehavior();
			const hasHeader = existing.startsWith(HEADER_COMMENT);
			const baseText = hasHeader
				? existing.slice(HEADER_COMMENT.length)
				: existing;
			const sep = baseText.trim().length > 0 ? "\n" : "";
			const prospective = (hasHeader ? HEADER_COMMENT : HEADER_COMMENT) + baseText.trimEnd() + sep + line + "\n";
			if (prospective.length > cap) {
				return {
					content: [
						{
							type: "text",
							text: `Behavior file full: ${existing.length}/${cap} chars. Remove a rule first (behavior_remove).`,
						},
					],
				};
			}
			writeBehaviorRaw(prospective);
			return {
				content: [
					{ type: "text", text: `Added behavior rule (${prospective.length}/${cap} chars): ${line}` },
				],
			};
		},
	});

	// --- behavior_remove ---
	pi.registerTool({
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
				return { content: [{ type: "text", text: "behavior_remove: line is empty." }] };
			}
			const lines = behaviorLines();
			const remaining = lines.filter((l) => l !== target);
			if (remaining.length === lines.length) {
				return { content: [{ type: "text", text: `Not found (no exact match): ${target}` }] };
			}
			writeBehaviorRaw(HEADER_COMMENT + (remaining.length > 0 ? remaining.join("\n") + "\n" : ""));
			return { content: [{ type: "text", text: `Removed behavior rule: ${target}` }] };
		},
	});

	// --- behavior_load ---
	pi.registerTool({
		name: "behavior_load",
		label: "Behavior Load",
		description: [
			"Read the current behavior file and show all rules with the size/cap.",
			"Use this to re-read after editing the file by hand, or to inspect it.",
		].join("\n"),
		parameters: Type.Object({}),
		async execute() {
			const raw = readBehavior();
			const cap = readCap();
			if (!raw.trim()) {
				return { content: [{ type: "text", text: `Behavior file is empty (0/${cap} chars).` }] };
			}
			// Strip header comment for display
			const display = raw
				.split("\n")
				.filter((l) => !l.startsWith("<!--"))
				.join("\n")
				.trimEnd();
			return {
				content: [
					{ type: "text", text: `Behavior (${raw.length}/${cap} chars):\n${display}` },
				],
			};
		},
	});
}