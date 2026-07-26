import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "title", description: "Set session display name (alias of /name)" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "usage", description: "Show session, context, and plan usage" },
	{ name: "context", description: "Show estimated context window breakdown" },
	{ name: "plan", description: "Toggle read-only plan mode (bare /plan toggles)", argumentHint: "[on|off|status]" },
	{ name: "mode", description: "Set permission mode: manual, yolo, or auto", argumentHint: "[manual|yolo|auto]" },
	{ name: "manual", description: "Activate manual permission mode (approve every action)" },
	{ name: "yolo", description: "Activate YOLO permission mode (auto-approve tools)" },
	{ name: "auto", description: "Activate auto permission mode (fully autonomous, no questions)" },
	{ name: "processes", description: "View and manage background processes started this session" },
	{ name: "rollback", description: "Undo the last turn's file changes and rewind the conversation" },
	{ name: "ollama-cloud-refresh", description: "Refresh Ollama Cloud models from the API" },
	{
		name: "thinking",
		description: "View or set the reasoning level, or show/hide thinking blocks",
		argumentHint: "[level|show|hide|toggle]",
	},
	{
		name: "memory-char-cap",
		description: "View or set the memory character cap (1-30000, default 5000)",
		argumentHint: "[n]",
	},
	{
		name: "goal",
		description: "Run a goal to completion",
		argumentHint: "[--tokens 100k] <goal_to_complete>",
	},
	{ name: "websearch", description: "Open web search curator", argumentHint: "[query, ...]" },
	{ name: "run", description: "Run a subagent directly", argumentHint: "agent[output=file] [task] [--bg] [--fork]" },
	{
		name: "chain",
		description: "Run agents in sequence",
		argumentHint: 'scout "task" -> planner [--bg] [--fork]',
	},
	{ name: "run-chain", description: "Run a saved chain", argumentHint: "chainName -- task [--bg] [--fork]" },
	{
		name: "parallel",
		description: "Run agents in parallel",
		argumentHint: 'scout "task1" -> reviewer "task2" [--bg] [--fork]',
	},
	{ name: "subagent-cost", description: "Show parent and subagent child usage cost for this session" },
	{ name: "subagents-doctor", description: "Show subagent diagnostics" },
	{ name: "subagents-fleet", description: "Open the live, inspection-only subagent fleet" },
	{ name: "subagents-stop", description: "Stop a current-session async subagent run", argumentHint: "[run-id]" },
	{ name: "subagents-models", description: "Show runtime-loaded builtin subagent models" },
	{ name: "subagents-profiles", description: "List saved subagent profiles" },
	{
		name: "subagents-load-profile",
		description: "Load a subagent profile into settings.json",
		argumentHint: "<name>",
	},
	{ name: "subagents-refresh-provider-models", description: "Refresh the cached model catalog for one provider" },
	{
		name: "subagents-generate-profiles",
		description: "Generate <provider>.quota and <provider>.quality subagent profiles",
	},
	{ name: "subagents-check-profile", description: "Check whether a saved profile still points to usable models" },
	{ name: "subagents-watchdog", description: "Show or toggle the default-off subagent watchdog" },
	{
		name: "curator",
		description: "Toggle or configure the search curator workflow",
		argumentHint: "[on|off|none|summary-review|auto-summary]",
	},
	{ name: "google-account", description: "Show the active Google account for Gemini Web" },
	{ name: "search", description: "Browse stored web search results" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "undo", description: "Undo the last turn (in-session only; use /redo to restore)" },
	{ name: "redo", description: "Restore a turn undone with /undo" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "init", description: "Generate a starter AGENTS.md for this project" },
	{ name: "swarm", description: "Orchestrate parallel subagents for a complex task", argumentHint: "<task>" },
	{
		name: "research",
		description: "Deep research with cited sources",
		argumentHint: "[--depth N] [--breadth N] <question>",
	},
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "sessions", description: "Browse and resume sessions" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
