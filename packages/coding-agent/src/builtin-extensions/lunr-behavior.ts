// @ts-nocheck
/**
 * lunr-behavior — user-defined behavior rules file (~/.lunr/agent/behavior.md).
 *
 * One user-managed file, injected into the system prompt every turn
 * (`before_agent_start`). The agent cannot read or change it through tools.
 *
 * Unlike memory, behavior lines do NOT get a date prefix (plain append, dedup
 * on exact line). The file lives at ~/.lunr/agent/behavior.md (honors
 * PI_CODING_AGENT_DIR like ashxj-thinking does — NOT ~/.pi).
 *
 * Loaded by lunR via jiti — no build step, plain TypeScript. `// @ts-nocheck`
 * because the extension API types are declared inline (see simple-pi-memory).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

interface BehaviorPresetBridge {
	getPreset(): string;
	syncFromFile(fileText: string): string;
}

function getPresetBridge(): BehaviorPresetBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/behavior-preset")] as
		| BehaviorPresetBridge
		| undefined;
}

function syncPresetFromFile(text: string): void {
	getPresetBridge()?.syncFromFile(text);
}

// ---------------------------------------------------------------------------
// Inline structural types
// ---------------------------------------------------------------------------
interface ExtensionAPI {
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
function readBehavior(): string {
	const file = behaviorFile();
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI): void {
	// --- Inject behavior rules into the system prompt every turn ---
	pi.on("before_agent_start", async (event) => {
		const content = readBehavior();
		syncPresetFromFile(content);
		if (!content.trim()) return; // inject nothing when empty
		// Strip the header comment from the injected text
		const body = content
			.split("\n")
			.filter((l) => !l.startsWith("<!--"))
			.join("\n")
			.trimEnd();
		if (!body) return;
		const block = "\n\n## Behavior rules (user-defined; follow these)\n" + body;
		return { systemPrompt: event.systemPrompt + block };
	});
}