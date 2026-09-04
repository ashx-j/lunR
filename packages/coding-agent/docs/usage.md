# Using lunR

This page collects day-to-day usage details that do not fit on the quickstart page. Built-in MCP, subagents, gateway, cron, plan, and related workflows are covered in [Built-in features](features.md).

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, git branch, session name, token/cache usage, cost, context usage, plan bar, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI. Click a thinking or tool card to expand or collapse that item. Smooth streaming (`smoothStreaming`, default off) is interactive TUI only.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected message |
| Images | Paste with Ctrl+V, Alt+V on Windows, `/paste-image`, or drag into the terminal. VS Code must forward Alt+V. Images insert `[image_n]` chips. |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization. Shift+Tab cycles permission mode (`manual` → `yolo` → `plan` → `auto`). Ctrl+O cycles `/tree` filters; it does not expand tool cards. `app.tools.expand` is unbound.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

Built-in commands (from `slash-commands.ts`):

| Command | Description |
|---------|-------------|
| `/settings` | Open settings menu |
| `/model` | Select model (stored-cred providers) |
| `/refresh` | Refresh model lists for all providers |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/export` | Export session (HTML default, or `.html`/`.jsonl` path) |
| `/import` | Import and resume a session from a JSONL file |
| `/share` | Share session as a secret GitHub gist. HTML viewer still defaults to https://pi.dev/session/ (leftover, not lunR-hosted). Override with `PI_SHARE_VIEWER_URL`. |
| `/copy` | Copy last agent message to clipboard |
| `/paste-image` | Paste an image from the clipboard |
| `/name`, `/title` | Set session display name |
| `/session` | Show session info and stats |
| `/usage` | This-session token totals, context, and every stored subscription plan (no `/token-usage`) |
| `/fast [on\|off\|status]` | Toggle Fast mode for OpenAI Codex subscriptions only |
| `/context` | Estimated context-window breakdown |
| `/plan` | Switch to plan permission mode, or `/plan <task>` to plan a task |
| `/mode` | Set permission mode: `manual`, `yolo`, `plan`, or `auto` |
| `/manual`, `/yolo`, `/auto` | Activate that permission mode |
| `/processes` | View and manage background processes started this session |
| `/rollback` | Undo the last turn's file changes and rewind the conversation |
| `/hotkeys` | Show all keyboard shortcuts |
| `/fork` | Create a new fork from a previous user message |
| `/clone` | Duplicate the current session at the current position |
| `/tree` | Navigate session tree (`ctrl+o` cycles filters) |
| `/undo` | Rewind the last turn (same session; `/redo` restores) |
| `/edit` | Rewind the last turn and put its text in the chat box |
| `/redo` | Restore a turn undone with `/undo` |
| `/trust` | Save project trust decision for future sessions |
| `/login`, `/auth` | Configure provider authentication |
| `/logout`, `/deauth` | Remove provider authentication |
| `/new` | Start a new session |
| `/init` | Generate a starter AGENTS.md for this project |
| `/compact` | Manually compact the session context |
| `/resume`, `/sessions` | Browse and resume sessions |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/quit`, `/exit` | Quit lunR |

There is no `/changelog` command.

Notable extension-registered commands (always available unless you disable those built-ins): `/thinking`, `/effort`, `/reasoning`, `/cron`, `/goal`, `/mcp`, `/mcp-auth`, `/lsp`, `/lsp-restart`, `/websearch`. See [Built-in features](features.md).

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want lunR to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.lunr/agent/sessions/`, organized by working directory.

```bash
lunr -c                  # Continue most recent session
lunr -r                  # Browse and select a session
lunr --no-session        # Ephemeral mode; do not save
lunr --name "my task"    # Set session display name at startup
lunr --session <path|id> # Use a specific session file or session ID
lunr --session-id <id>   # Exact project session ID, created if missing
lunr --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.
- `/undo` / `/edit` / `/redo` stay in the same session. `/rollback` forks and restores files.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

lunR loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.lunr/agent/agents/AGENTS.md` for global instructions
- `~/.lunr/agent/agents/<model-name>/AGENTS.md` for optional model-specific instructions enabled in `/settings`
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.lunr/SYSTEM.md` for a project
- `~/.lunr/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, lunR asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.lunr/agent/trust.json`. Trusting a project allows lunR to load `.lunr/settings.json` and `.lunr` resources, install missing project packages, and execute project extensions.

Before the trust decision, lunR loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.lunr/agent/settings.json`, or change it with `/settings`.

`lunr config` and package commands use the same project trust flow. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them. `lunr update` never prompts; it only reinstalls the global CLI.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.lunr/agent/trust.json` only; the current session is not reloaded, so restart lunR for changes to take effect.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist. The HTML viewer URL still defaults to https://pi.dev/session/ — that is an intentional leftover, not a lunR-hosted viewer. Set `PI_SHARE_VIEWER_URL` to point elsewhere.

## CLI Reference

```bash
lunr [options] [@files...] [messages...]
```

### Product and Package Commands

```bash
lunr setup                         # First-run / reconfigure optional features
lunr features [list|enable|disable]
lunr gateway […]                   # Chat gateway (requires chat-platforms)
lunr uninstall [--purge]           # Remove this lunR install (keeps ~/.lunr/agent unless --purge)
lunr uninstall <source> [-l]       # Remove an extension package (alias for remove)
lunr install <source> [-l]         # Install package, -l for project-local
lunr remove <source> [-l]          # Remove package
lunr list                          # List installed packages
lunr config                        # Enable/disable package resources
lunr update                        # Reinstall global @ashx-j/lunr only
lunr update --self                 # Same as lunr update
```

`lunr update` does not take `--models`, `--all`, `--force`, or `--extensions`. Refresh catalogs with `/refresh`. Workspace `npx lunr` from this repo refuses to self-update.

To uninstall lunR itself, see [Quickstart](quickstart.md#uninstall). `lunr config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command.

See [Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, lunR also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | lunr -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--session-id <id>` | Use exact project session ID, creating it if missing |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Default on: `read`, `bash`, `edit`, `write`. `grep`/`find`/`ls` start off.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
lunr --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `--offline` | Disable startup network operations (same as `PI_OFFLINE=1`) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
lunr @prompt.md "Answer this"
lunr -p @screenshot.png "What's in this image?"
lunr @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
lunr "List all .ts files in src/"

# Non-interactive
lunr -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | lunr -p "Summarize this text"

# Named one-shot session
lunr --name "release audit" -p "Audit this repository"

# Different model
lunr --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
lunr --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
lunr --model sonnet:high "Solve this complex problem"

# Limit model cycling
lunr --models "claude-*,gpt-4o"

# Read-only mode
lunr --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
lunr --exclude-tools ask_question

# Offline (no startup network)
lunr --offline
```

### Environment Variables

These names stay `PI_*`. Do not invent `LUNR_*` replacements for them.

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override config directory; default is `~/.lunr/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable startup network operations, including the npm update check and package update checks |
| `PI_SHARE_VIEWER_URL` | Base URL for `/share` HTML viewer (default: `https://pi.dev/session/`) |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

`PI_SKIP_VERSION_CHECK` and `PI_TELEMETRY` are not used by lunR. Gateway bot tokens optionally use `LUNR_TELEGRAM_BOT_TOKEN` / `LUNR_DISCORD_BOT_TOKEN`.

## Design Principles

lunR keeps the core small and still ships the workflows most coding agents expect: MCP, subagents, permission modes, plan + `present_plan`, todos, `/processes`, cron, gateway, web search, LSP, agent memory, goals, intercom, skill-creator, and model tiers. Everything else stays in extensions, skills, prompt templates, and packages.

See [Built-in features](features.md) and the [README philosophy](../README.md#philosophy).
