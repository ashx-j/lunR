<p align="center">
  <strong>lunR</strong><br />
  a terminal coding agent
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@ashx-j/lunr"><img alt="npm" src="https://img.shields.io/npm/v/@ashx-j/lunr?style=flat-square" /></a>
  <a href="https://github.com/ashx-j/lunR"><img alt="GitHub" src="https://img.shields.io/badge/github-ashx--j%2FlunR-181717?style=flat-square&logo=github" /></a>
</p>

lunR is a terminal coding agent derived from [pi](https://github.com/badlogic/pi-mono). It ships with interactive TUI, print/JSON, RPC, and SDK modes, plus baked-in MCP, subagents, permissions, plan mode, todos, cron, and a Telegram/Discord gateway.

Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Bundle those as [packages](#packages) and share them via npm or git.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Packages](#packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

Requires **Node.js ≥ 22.19**.

```bash
npm i -g @ashx-j/lunr
```

`--ignore-scripts` is optional; lunR does not require install scripts for a normal npm install.

Then run it in a project directory:

```bash
cd /path/to/project
lunr
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lunr
```

Or use a subscription / stored credential:

```bash
lunr
/login  # Then select provider
```

First-run optional features (Telegram/Discord gateway):

```bash
lunr setup
lunr features list
```

To remove the CLI, keep `~/.lunr/agent` unless you pass `--purge`:

```bash
lunr uninstall           # remove this lunR install; keeps ~/.lunr/agent
lunr uninstall --purge   # also wipe ~/.lunr/agent (settings, credentials, sessions)
lunr uninstall npm:@foo/bar   # remove an extension package (alias for lunr remove)
```

You can also `npm uninstall -g @ashx-j/lunr`. That leaves `~/.lunr/agent` in place.

Config lives in `~/.lunr/agent` (global) and project `.lunr/` (`piConfig.configDir`). Override the agent dir with `PI_CODING_AGENT_DIR`. **Do not use `~/.pi/` as the lunR home.**

Then just talk to lunR. By default it gives the model four tools: `read`, `write`, `edit`, and `bash`. `grep`, `find`, and `ls` exist but start off. Add more via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [packages](#packages). See [built-in features](docs/features.md) for MCP, subagents, plan mode, cron, and the gateway.

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

lunR ships a built-in catalog. First paint is **cache-only** (no GitHub or live `/models` at startup). Authenticate with `/login` or an API key, then pick a model with `/model` (or Ctrl+L).

`/model` lists **stored-credential** providers only (`~/.lunr/agent/auth.json`, subscriptions, or `--api-key`). An ambient `OPENROUTER_API_KEY` does not make OpenRouter models appear in `/model`.

Refresh catalogs with **`/refresh`**, not `lunr update`. `/refresh` downloads `providers.json` and then shards for providers that already have stored credentials. `lunr update` only reinstalls the global CLI.

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- xAI SuperGrok (Grok/X subscription)
- Radius

**Local / live:**
- Ollama and LM Studio via `/login` (localhost probe)
- OpenCode Zen: `/login opencode` then `/refresh` (free rows rotate from live `/v1/models`)

**API keys:** Anthropic, Ant Ling, OpenAI, Azure OpenAI, DeepSeek, NVIDIA NIM, Google Gemini, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, Cloudflare AI Gateway, Cloudflare Workers AI, xAI, OpenRouter, Vercel AI Gateway, ZAI Coding Plan, OpenCode Zen/Go, Hugging Face, Fireworks, Together AI, Kimi For Coding, MiniMax, Xiaomi MiMo, Qwen Token Plan.

See [docs/providers.md](docs/providers.md) for setup. **xAI SuperGrok:** `/login xai` can import `~/.grok/auth.json` from the Grok CLI; `/logout xai` does **not** delete that file.

**Custom providers & models:** Add providers via `~/.lunr/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, git branch, session name, token/cache usage, cost, context usage, plan bar, current model. Customize under `/settings` → Customize → Footer.

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions. [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V normally, Alt+V on Windows. VS Code must forward Alt+V, or use `/paste-image` without a shortcut. Images insert `[image_n]` chips, not a temp path. |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/auth` | Configure provider authentication |
| `/logout`, `/deauth` | Remove provider authentication |
| `/model` | Switch models (stored-cred providers) |
| `/refresh` | Refresh model catalogs |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Theme, thinking, agent memory, message delivery, transport |
| `/thinking`, `/effort`, `/reasoning` | Set thinking level (`xhigh`/`max` are opt-in when the model supports them) |
| `/mode` | Set permission mode: `manual`, `yolo`, `plan`, or `auto` (Shift+Tab cycles) |
| `/plan` | Switch to plan mode, or `/plan <task>` to plan a task |
| `/manual`, `/yolo`, `/auto` | Activate that permission mode |
| `/swarm` | Orchestrate parallel subagents |
| `/cron` | Scheduled prompts (`~/.lunr/agent/cron/`) |
| `/goal` | Session goal (forces session auto permission mode) |
| `/processes` | Background processes started this session |
| `/usage` | This-session token totals, context, and every stored subscription plan |
| `/fast` | Toggle Fast mode for OpenAI Codex subscriptions |
| `/context` | Estimated context-window breakdown |
| `/resume`, `/sessions` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name`, `/title` | Set session display name |
| `/session` | Show session info |
| `/tree` | Jump to any point in the session (`ctrl+o` cycles filters) |
| `/undo`, `/edit`, `/redo` | Same-session rewind; `/edit` pastes the last prompt |
| `/rollback` | Undo the last turn's file changes (forks) |
| `/trust` | Save project trust decision |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch |
| `/compact [prompt]` | Manually compact context |
| `/copy` | Copy last assistant message |
| `/paste-image` | Paste an image from the clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a JSONL session |
| `/share` | Upload as a private GitHub gist (HTML viewer still defaults to https://pi.dev/session/ — leftover, not lunR-hosted) |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/init` | Generate a starter AGENTS.md |
| `/quit`, `/exit` | Quit lunR |

There is no `/changelog` or `/token-usage` command.

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.lunr/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle permission mode (`manual` → `yolo` → `plan` → `auto`) |
| Ctrl+O | Cycle `/tree` filters (not tool expand) |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

Click a thinking or tool card to expand or collapse that item. `app.tools.expand` is unbound.

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so lunR can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.lunr/agent/sessions/` organized by working directory.

```bash
lunr -c                  # Continue most recent session
lunr -r                  # Browse and select from past sessions
lunr --no-session        # Ephemeral mode (don't save)
lunr --name "my task"    # Set session display name at startup
lunr --session <path|id> # Use specific session file or ID
lunr --session-id <id>   # Use exact project session ID, creating it if missing
lunr --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Ctrl+X to copy the selected message
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch.

**`/clone`** - Duplicate the current active branch into a new session file at the current position.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.lunr/agent/settings.json` | Global (all projects) |
| `.lunr/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, lunR asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.lunr/agent/trust.json`. Trusting a project allows lunR to load `.lunr/settings.json` and `.lunr` resources, install missing project packages, and execute project extensions.

Before the trust decision, lunR loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

`lunr config` and package commands use the same project trust flow. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them. `lunr update` never prompts (it only reinstalls the global CLI).

Use `/trust` in interactive mode to save a project trust decision for future sessions. It writes `~/.lunr/agent/trust.json` only; the current session is not reloaded, so restart lunR for changes to take effect.

### Offline and updates

Use `--offline` or `PI_OFFLINE=1` to skip startup network operations (npm update check, package update checks, live catalog probes). First interactive paint is already cache-only.

`lunr update` / `lunr update --self` reinstalls global `@ashx-j/lunr` from npm. It is not a catalog refresh and does not take `--models`, `--all`, or `--force`. Workspace `npx lunr` (this repo) refuses to self-update; install the published package to use `lunr update`.

---

## Context Files

lunR loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.lunr/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use `~/.lunr/agent/AGENTS.md` for optional global behavior and instructions; the model cannot change this user-managed file. Use project files for project conventions and commands. All matching files are concatenated. Run `/reload` after adding or editing one while lunR is open.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.lunr/SYSTEM.md` (project) or `~/.lunr/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.lunr/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.lunr/agent/prompts/`, `.lunr/prompts/`, or a [package](#packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.lunr/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.lunr/agent/skills/`, `~/.agents/skills/`, `.lunr/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [package](#packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend lunR with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
import type { ExtensionAPI } from "@ashx-j/lunr";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The factory argument is conventionally named `pi` (`export default function (pi: ExtensionAPI)`). Keep that. The jiti loader aliases both `@ashx-j/lunr` and `@earendil-works/pi-coding-agent` when loading extensions.

The default export can also be `async`. lunR waits for async extension factories before startup continues.

Place in `~/.lunr/agent/extensions/`, `.lunr/extensions/`, or a [package](#packages). See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/). Sample extensions such as `examples/extensions/plan-mode`, `todo.ts`, and `subagent/` are **Extension API samples**, not the product implementation. lunR ships plan mode, todos, and subagents as built-ins; see [docs/features.md](docs/features.md).

### Themes

Built-in theme: **`moon` only** (`getDefaultTheme()` returns `"moon"`). Themes hot-reload: modify the active theme file and lunR immediately applies changes.

Place custom themes in `~/.lunr/agent/themes/`, `.lunr/themes/`, or a [package](#packages). Schema: [theme-schema.json](https://github.com/ashx-j/lunR/blob/master/packages/coding-agent/src/modes/interactive/theme/theme-schema.json) (also packed as `dist/modes/interactive/theme/theme-schema.json`). See [docs/themes.md](docs/themes.md).

### Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. The package resource manifest key in `package.json` is still `"pi"` (`extensions`, `skills`, `prompts`, `themes`). Keep that key.

> **Security:** Packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
lunr install npm:@foo/lunr-tools
lunr install npm:@foo/lunr-tools@1.2.3      # pinned version
lunr install git:github.com/user/repo
lunr install git:github.com/user/repo@v1  # tag or commit
lunr remove npm:@foo/lunr-tools
lunr uninstall npm:@foo/lunr-tools          # alias for remove (requires a source)
lunr list
lunr config                               # enable/disable extensions, skills, prompts, themes
lunr update                               # reinstall global @ashx-j/lunr only
```

`lunr update` does **not** refresh model catalogs or extension packages. Use `/refresh` for catalogs and `lunr install <source>` to move a git package to a new ref.

Packages install to `~/.lunr/agent/git/` (git) or `~/.lunr/agent/npm/` (npm). Use `-l` for project-local installs (`.lunr/git/`, `.lunr/npm/`). Git `@ref` values are pinned tags or commits. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers.

Create a package by adding a `pi` key to `package.json`:

```json
{
  "name": "my-lunr-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, lunR auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@ashx-j/lunr";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

Default `agentDir` is `~/.lunr/agent`. For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
lunr --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

lunR keeps a small core and still lets you shape the product with [extensions](#extensions), [skills](#skills), and [packages](#packages). Unlike upstream pi, lunR **does** ship the workflows most coding agents expect:

- **MCP** — `/mcp`, `/mcp-auth`
- **Subagents** — always fresh; `/swarm`; 3+ parallel in one turn is a swarm (gated in manual **and** yolo); default parallel concurrency is unlimited
- **Permission modes** — `manual | yolo | plan | auto`; Shift+Tab cycles that order
- **Plan mode** — `/plan` plus the `present_plan` tool
- **Todos** — lunr-todos (full-replace)
- **Background processes** — `/processes`
- **Cron** — `/cron`, `~/.lunr/agent/cron/` (TUI live session or gateway origin)
- **Gateway** — `lunr gateway` for Telegram and Discord
- **Web search, LSP, agent memory, goals, intercom, skill-creator, model tiers**

See [docs/features.md](docs/features.md) for how those work. Build anything else with extensions.

---

## CLI Reference

```bash
lunr [options] [@files...] [messages...]
```

### Product Commands

```bash
lunr setup                         # First-run / reconfigure optional features
lunr features [list|enable|disable]
lunr gateway […]                   # Chat gateway daemon (requires chat-platforms feature)
lunr uninstall [--purge]           # Remove this lunR install (keeps ~/.lunr/agent unless --purge)
lunr uninstall <source> [-l]       # Remove an extension package (alias for remove)
lunr install <source> [-l]         # Install package, -l for project-local
lunr remove <source> [-l]          # Remove package
lunr list                          # List installed packages
lunr config                        # Enable/disable package resources
lunr update                        # Reinstall global @ashx-j/lunr only
lunr update --self                 # Same as lunr update
```

`lunr update` does not take `--models`, `--all`, `--force`, or `--extensions`. Refresh catalogs with `/refresh`.

`lunr config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, lunR also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | lunr -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--session-id <id>` | Use exact project session ID, creating it if missing |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `--offline` | Disable startup network operations (same as `PI_OFFLINE=1`) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

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

# Model with provider prefix (no --provider needed)
lunr --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
lunr --model sonnet:high "Solve this complex problem"

# Limit model cycling
lunr --models "claude-*,gpt-4o"

# Read-only mode
lunr --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
lunr --exclude-tools ask_question

# High thinking level
lunr --thinking high "Solve this complex problem"

# Offline (no startup network)
lunr --offline
```

### Environment Variables

These names stay `PI_*`. Do not invent `LUNR_*` replacements for them.

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override config directory (default: `~/.lunr/agent`) |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `PI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `PI_OFFLINE` | Disable startup network operations when set to `1`/`true`/`yes` |
| `PI_SHARE_VIEWER_URL` | Base URL for `/share` HTML viewer (default: `https://pi.dev/session/` — leftover) |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

Gateway bot tokens (optional) use `LUNR_TELEGRAM_BOT_TOKEN` / `LUNR_DISCORD_BOT_TOKEN` (or `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN`) and are stored in `~/.lunr/agent/gateway.json`.

---

## Development

See [docs/development.md](docs/development.md) for setup, forking, and debugging. Source: [github.com/ashx-j/lunR](https://github.com/ashx-j/lunR).

## License

MIT

## See Also

- [@ashx-j/lunr-ai](https://www.npmjs.com/package/@ashx-j/lunr-ai): Core LLM toolkit
- [@ashx-j/lunr-agent](https://www.npmjs.com/package/@ashx-j/lunr-agent): Agent framework
- [@ashx-j/lunr-tui](https://www.npmjs.com/package/@ashx-j/lunr-tui): Terminal UI components
