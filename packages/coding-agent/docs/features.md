# Built-in features

lunR ships these workflows as baked-in extensions. You do not need a third-party package for MCP, subagents, plan mode, or todos.

Sample code under `examples/extensions/plan-mode`, `examples/extensions/todo.ts`, and `examples/extensions/subagent/` is **Extension API sample code**, not the product implementation.

## Permissions and plan mode

Permission modes: `manual | yolo | plan | auto`. Shift+Tab (`app.mode.cycle`) cycles that order. Thinking cycle is unbound; use `/thinking`, `/effort`, or `/reasoning`.

- **manual** — approve every tool
- **yolo** — auto-approve tools; **does not** bypass the swarm gate
- **plan** — read-oriented planning; the model calls `present_plan` with a summary; you approve or decline in a dock
- **auto** — fully autonomous

`/plan` enters plan mode. `/plan <task>` enters plan mode and sends the task. If you are already in plan, `/plan <task>` restores the previous mode and sends. Default startup mode is `defaultPermissionMode` in settings (`manual`).

`present_plan` is only available in plan mode. After approval, interactive lunR leaves plan mode before the tool result resolves.

## Subagents and swarm

Advertised subagents always start **fresh** (no forked parent context). Default parallel concurrency / max tasks / global run cap are unlimited; an explicit `concurrency` is still honored.

A **swarm** is 3+ parallel subagents in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls. Swarms are gated in **manual and yolo**. Sequential work stays `chain`.

- `/swarm <task>` — orchestrate parallel subagents

`/goal` sets a session goal and **forces session auto** permission mode.

## Todos, memory, and global instructions

- **Todos** — lunr-todos is a full-replace list. Completed todos prune on the next user turn (no leftover `✓ N done` footer).
- **Agent memory** — durable established facts and stable preferences in `~/.lunr/simple-memory/memory.md`. `/settings` → Agent memory controls injection and the `memory_add`, `memory_remove`, and `memory_load` tools without deleting stored facts. `memoryCharCap` defaults to 5000. Behavior instructions, transient task state, transcripts, guesses, and secrets do not belong in memory.
- **Global instructions** — create `~/.lunr/agent/AGENTS.md` yourself when you want global behavior or instructions. lunR injects it through the normal context loader; `/reload` picks up changes. The model cannot modify this user-managed file. The retired `behavior.md` file and behavior presets are no longer loaded.

## Cron

`/cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status`

Jobs persist in `~/.lunr/agent/cron/` (`jobs.json`). Interactive TUI cron runs in the live session. `lunr gateway` runs the same scheduler with a fresh headless session. TUI cron uses the same deliver allowlist as the gateway.

`cronFallbackModels` in settings is a hand-edited list of `provider/modelId` entries tried in order when a gateway cron fire fails.

Schedule examples: `every 30m`, `every 2h`, `every 1d`, a duration one-shot (`30m`), an ISO timestamp, or a 5-field cron expression.

## Gateway (Telegram / Discord)

Enable the chat-platforms feature, then run the daemon:

```bash
lunr setup
lunr features enable chat-platforms
lunr gateway
```

Config: `~/.lunr/agent/gateway.json` (chmod 0600; may hold bot tokens). Secrets do not go in `install-features.json`.

Token resolution: `LUNR_<PLATFORM>_BOT_TOKEN` env → `<PLATFORM>_BOT_TOKEN` env → file token.

```bash
lunr gateway                     # run the daemon
lunr gateway pair approve <platform> <code>
lunr gateway pair list
lunr gateway status
```

- Telegram: long-poll bot. Talk to @BotFather, put the token in `gateway.json` or `LUNR_TELEGRAM_BOT_TOKEN`, set `telegram.enabled = true`.
- Discord: mention-gated by default (`requireMention: true`). Enable the Message Content intent. No GuildMembers intent. Put the token in `gateway.json` or `LUNR_DISCORD_BOT_TOKEN`.
- Authz is fail-closed. Unauthorized DMs pair (`unauthorizedDmBehavior: "pair"`) unless you set `ignore`.
- Gateway `/new` while a session is busy aborts the live turn and drops the queue.

Without runnable adapters (enabled platform + resolvable token), `lunr gateway` prints setup instructions and exits 1.

## MCP, LSP, web search

- **MCP** — `/mcp`, `/mcp-auth`. Footer MCP segment is on by default (`footerMcp`).
- **LSP** — `/lsp`, `/lsp-restart`, `/lsp-config`. Footer LSP segment is off by default (`footerLsp`). On Windows, npm `.cmd` shims need a real LSP start (`shell: true`); if the server never starts, tools silently fall back to tree-sitter. Check `/lsp` if language features look missing.
- **Web search** — `/websearch` (and related search commands). Interactive TUI attaches web-access after first paint; print/RPC/gateway load it before the first turn.

## Thinking, usage, streaming, UI

- `/thinking`, `/effort`, and `/reasoning` are full-parity aliases. `/thinking` only offers levels the session model supports (`getSupportedThinkingLevels`). `xhigh` and `max` are opt-in.
- `/usage` is **this-session** context plus every stored-credential subscription plan. The current provider is included for env-only auth. There is no `/token-usage`.
- `/fast [on|off|status]` controls `service_tier: "fast"` for OpenAI Codex subscriptions only. It persists across new sessions, gateway turns, and subagents. Paid `openai` API models do not use it.
- Footer plan bar prefers a 5h window and falls back to weekly (`planUsageWindow`). In Customize, Plan usage hides the whole segment while Plan bar hides only the █░ fill and keeps the percent.
- Click a ✻ Thought or tool card to expand/collapse that item. `app.tools.expand` is unbound. `/tree` still uses `ctrl+o` for filters.
- Smooth streaming (`smoothStreaming`, default off) is **interactive TUI only** (grapheme reveal at ~30 FPS). Print, RPC, and gateway stay unsmoothed.
- Image paste inserts `[image_n]` chips. Windows uses **Alt+V**; VS Code must forward it because it owns Ctrl+V and Alt+V. `/paste-image` bypasses terminal shortcuts.
- Model tiers: `/settings` Enable model tiers. Per-tier thinking; unset = parent session.

## Updates, catalogs, local models

- `lunr update` / `lunr update --self` reinstalls global `@ashx-j/lunr` only. Workspace `npx lunr` is not a published install and will not self-update.
- Catalog refresh is `/refresh`. First paint is cache-only. `/model` lists stored-cred providers only.
- **xAI SuperGrok:** `/login xai` can import `~/.grok/auth.json` from the Grok CLI. `/logout xai` does not delete that file.
- **Ollama / LM Studio:** `/login` and select the local provider (localhost probe).
- **OpenCode Zen:** `/login opencode` then `/refresh`. Do not add a second Zen provider.

## Intercom and skill-creator

- **Intercom** — `/intercom` for the built-in intercom broker.
- **Skill-creator** — `/skill:skill-creator` (model invocation disabled by default). Global skills go in `~/.lunr/agent/skills/<name>/`; project skills in `.lunr/skills/<name>/` (requires trust).
