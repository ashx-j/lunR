# lunR Documentation

lunR is a terminal coding agent derived from pi. It stays small at the core while shipping MCP, subagents, permissions, plan mode, todos, cron, and a Telegram/Discord gateway — and it still extends through TypeScript extensions, skills, prompt templates, themes, and packages.

## Quick start

Requires **Node.js ≥ 22.19**.

```bash
npm i -g @ashx-j/lunr
```

`--ignore-scripts` is optional; lunR does not require install scripts for a normal npm install.

There is no pi.dev curl installer. Then run it in a project directory:

```bash
lunr
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting lunR.

Optional features (chat gateway):

```bash
lunr setup
lunr features list
lunr features enable chat-platforms
```

To uninstall the CLI:

```bash
lunr uninstall              # keeps ~/.lunr/agent
lunr uninstall --purge      # also wipes ~/.lunr/agent
```

`lunr uninstall <source>` removes an extension package (alias for `lunr remove`). `npm uninstall -g @ashx-j/lunr` also leaves `~/.lunr/agent` in place.

Config: `~/.lunr/agent` globally, project `.lunr/`. Override with `PI_CODING_AGENT_DIR`. Never use `~/.pi/` as the lunR home.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using lunR](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Built-in features](features.md) - gateway, cron, MCP, LSP, subagents, plan, todos, and more.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox lunR with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in `moon` theme and custom terminal themes.
- [Packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed lunR in Node.js applications (`npm install @ashx-j/lunr`).
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
