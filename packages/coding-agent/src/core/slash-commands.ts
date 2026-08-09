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
	{ name: "refresh", description: "Refresh model lists for all providers" },
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
	{
		name: "plan",
		description: "Toggle read-only plan mode, or /plan <task> to plan a task",
		argumentHint: "[on|off|status|<task>]",
	},
	{ name: "mode", description: "Set permission mode: manual, yolo, or auto", argumentHint: "[manual|yolo|auto]" },
	{ name: "manual", description: "Activate manual permission mode (approve every action)" },
	{ name: "yolo", description: "Activate YOLO permission mode (auto-approve tools)" },
	{ name: "auto", description: "Activate auto permission mode (fully autonomous, no questions)" },
	{ name: "processes", description: "View and manage background processes started this session" },
	{ name: "rollback", description: "Undo the last turn's file changes and rewind the conversation" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "undo", description: "Undo the last turn (in-session only; use /redo to restore)" },
	{ name: "redo", description: "Restore a turn undone with /undo" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "auth", description: "Configure provider authentication (alias of /login)", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "deauth", description: "Remove provider authentication (alias of /logout)" },
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
	{ name: "exit", description: `Quit ${APP_NAME} (alias of /quit)` },
];
