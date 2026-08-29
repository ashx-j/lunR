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

## Subagents, swarm, research

Advertised subagents always start **fresh** (no forked parent context). Default parallel concurrency / max tasks / global run cap are unlimited; an explicit `concurrency` is still honored.

A **swarm** is 3+ parallel subagents in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls. Swarms are gated in **manual and yolo**. Sequential work stays `chain`.

- `/swarm <task>` — orchestrate parallel subagents
- `/research [--depth N] [--breadth N] <question>` — deep research with cited sources

`/goal` sets a session goal and **forces session auto** permission mode.

## Todos, memory, behavior

- **Todos** — lunr-todos is a full-replace list. Completed todos prune on the next user turn (no leftover `✓ N done` footer).
- **Memory** — simple memory under the agent dir. Cap with `memoryCharCap` (default 5000; built-in behavior presets skip the cap).
- **Behavior presets** — `/settings` → Behavior preset: `default` (empty, fill later) / `humanizer` / `concise` / `custom`. Built-ins replace `~/.lunr/agent/behavior.md`. Custom keeps the file; there is no in-app editor and no `fs.watch`. Drift off a template flips to custom.

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
- `/usage` is **this-session** context plus plan usage. There is no `/token-usage`.
- Footer plan bar prefers a 5h window and falls back to weekly (`planUsageWindow`). Customize → Footer: plan usage hides the whole segment; Footer: plan bar hides only the █░ fill and keeps the percent.
- Click a ✻ Thought or tool card to expand/collapse that item. `app.tools.expand` is unbound. `/tree` still uses `ctrl+o` for filters.
- Smooth streaming (`smoothStreaming`, default off) is **interactive TUI only** (grapheme reveal at ~30 FPS). Print, RPC, and gateway stay unsmoothed.
- Image paste inserts `[image_n]` chips. On Windows, paste is **Alt+V** (Ctrl+V is the terminal’s). VS Code may eat Alt+V; forward it with `sendSequence` `\u001b[118;3u`.
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
