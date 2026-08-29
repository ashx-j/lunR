# Quickstart

This page gets you from install to a useful first lunR session.

## Install

Requires **Node.js ≥ 22.19**. lunR is distributed as `@ashx-j/lunr`:

```bash
npm i -g @ashx-j/lunr
```

`--ignore-scripts` is optional; lunR does not require install scripts for a normal npm install. There is no pi.dev `install.sh`.

### Uninstall

Product uninstall vs package uninstall:

```bash
# Remove this lunR install; keeps ~/.lunr/agent
lunr uninstall

# Also wipe ~/.lunr/agent (settings, credentials, sessions, packages)
lunr uninstall --purge

# Remove an extension package (alias for lunr remove)
lunr uninstall npm:@foo/bar
```

You can also uninstall the npm package itself:

```bash
npm uninstall -g @ashx-j/lunr
pnpm remove -g @ashx-j/lunr
yarn global remove @ashx-j/lunr
bun uninstall -g @ashx-j/lunr
```

`npm uninstall -g` leaves settings, credentials, sessions, and installed packages in `~/.lunr/agent/`. Use `lunr uninstall --purge` to wipe that directory.

Optional first-run features (Telegram/Discord gateway):

```bash
lunr setup
lunr features list
lunr features enable chat-platforms
```

Then start lunR in the project directory you want it to work on:

```bash
cd /path/to/project
lunr
```

Config lives in `~/.lunr/agent` (global) and project `.lunr/`. Override with `PI_CODING_AGENT_DIR`. Never use `~/.pi/` as the lunR home.

## Authenticate

lunR can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start lunR and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot, and xAI SuperGrok.

`/login xai` can import the Grok CLI session from `~/.grok/auth.json`. `/logout xai` does not delete that file.

Local Ollama and LM Studio: `/login` and select the local provider (lunR probes localhost). OpenCode Zen: `/login opencode` then `/refresh`.

### Option 2: API key

Set an API key before launching lunR:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lunr
```

You can also run `/login` and select an API-key provider to store the key in `~/.lunr/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

`/model` lists **stored-credential** providers only. An environment variable such as `OPENROUTER_API_KEY` does not list that provider until you store a credential or pass `--api-key`. First paint is cache-only; run `/refresh` to pull newer catalogs.

## First session

Once lunR starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, lunR gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) exist but start off. lunR runs in your current working directory and can modify files there. Use git or `/rollback` if you want easy undo.

Permission modes are `manual | yolo | plan | auto`. Shift+Tab cycles that order. In plan mode the model uses `present_plan` for approval.

## Give lunR project instructions

lunR loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

lunR loads:

- `~/.lunr/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart lunR, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
lunr @README.md "Summarize this"
lunr @src/app.ts @src/app.test.ts "Review these together"
```

Paste images with Ctrl+V (Alt+V on Windows). The editor inserts `[image_1]`, `[image_2]`, … chips instead of a temp path. Dragging images into supported terminals also works.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context. `/processes` lists background processes started this session.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle permission mode (manual → yolo → plan → auto). Use `/thinking`, `/effort`, `/reasoning`, or `/settings` to change thinking level. `xhigh` and `max` are opt-in when the model supports them. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models. Catalog refresh is `/refresh`, not `lunr update`.

### Continue later

Sessions are saved automatically:

```bash
lunr -c                  # Continue most recent session
lunr -r                  # Browse previous sessions
lunr --name "my task"    # Set session display name at startup
lunr --session <path|id> # Open a specific session
lunr --session-id <id>   # Exact project session ID (created if missing)
```

Inside lunR, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. `/undo` rewinds the same session; `/edit` rewinds and pastes; `/rollback` forks and restores files.

### Non-interactive mode

For one-shot prompts:

```bash
lunr -p "Summarize this codebase"
cat README.md | lunr -p "Summarize this text"
lunr -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration. `--offline` (or `PI_OFFLINE=1`) skips startup network operations.

### Update

```bash
lunr update          # reinstall global @ashx-j/lunr from npm
lunr update --self   # same
```

Workspace `npx lunr` from this repo is not a published install and will not self-update. Catalog refresh is `/refresh`. Extra flags such as `--models`, `--all`, and `--force` are invalid.

## Next steps

- [Using lunR](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Built-in features](features.md) - gateway, cron, MCP, subagents, plan, todos, and more.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
