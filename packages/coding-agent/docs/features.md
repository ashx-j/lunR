# Built-in features

lunR ships these workflows as baked-in extensions. You do not need a third-party package for MCP, subagents, plan mode, or todos.

Sample code under `examples/extensions/plan-mode`, `examples/extensions/todo.ts`, and `examples/extensions/subagent/` is **Extension API sample code**, not the product implementation.

## Permissions and plan mode

Permission modes: `manual | yolo | plan | auto`. Shift+Tab (`app.mode.cycle`) cycles that order. Ctrl+T (`app.thinking.cycle`) cycles thinking levels for the selected model.

- **manual** — approve every tool
- **yolo** — auto-approve ordinary tools; large subagent launches still request confirmation
- **plan** — read-oriented planning; the model calls `present_plan` with a summary; you approve or decline in a dock
- **auto** — fully autonomous

`/plan` enters plan mode. `/plan <task>` enters plan mode and sends the task. If you are already in plan, `/plan <task>` restores the previous mode and sends. Default startup mode is `defaultPermissionMode` in settings (`manual`).

`present_plan` is only available in plan mode. After approval, interactive lunR leaves plan mode before the tool result resolves.

## Subagents

Advertised subagents always start **fresh** (no forked parent context). Default parallel concurrency / max tasks / global run cap are unlimited; an explicit `concurrency` is still honored.

Collapsed subagent rows (foreground and async) are one line: status glyph, description, selected tier or explicit model, tokens, and elapsed time. Running rows keep a live spinner and clock; completed collapsed rows freeze those stats. Async launches show `subagent async` in the tool header. Completed notify cards show title and status only; the model still receives the full result text.

A launch of 3+ parallel children in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls, receives one aggregate confirmation in **manual and yolo**. Sequential work stays `chain`. Auto bypasses this confirmation, and it can be disabled independently in `/settings`.

`/goal` sets a session goal and **forces session auto** permission mode.

### Questions to async children

The parent can use `subagent_supervisor` with `action: "ask"` to ask a running async child for information it needs before the final report. The request names the run, selects one child, and includes a `reason` explaining which decision needs the answer.

Asking returns a question ID without waiting. The child receives the question at a safe turn boundary, replies from its current findings, and continues its assigned task. Answers arrive separately from the run's final result and wake an idle parent. A delivery receipt is not an answer. Questions do not change the assignment, broadcast to other children, or restart finished children.

The parent calls `subagent_supervisor({ action: "ask", id, index, reason, message })`. It must select an `index` or private `childId` when several children are running. The child answers with `contact_supervisor({ action: "reply", replyTo: questionId, message })`. If the parent's next decision must wait, `subagent_wait({ questionId })` returns the answer instead of sending a second notification. Read-only children can reply without receiving editing tools.

A child must have an active question-capable input channel. Only one question may be outstanding per child. Questions expire after ten minutes by default, and child termination, failed delivery, process replacement, or parent session replacement cancels pending questions. A wait timeout ends the wait, not the question. Existing blocking child-to-parent requests take priority to avoid mutual waiting.

The agent must ask only when the child has missing context, the answer changes a concrete next decision, and waiting for completion would block progress or risk rework. It must use available results first and batch related questions. Routine progress checks, duplicate questions, polling, and step-by-step supervision are prohibited. A follow-up is appropriate only when the answer leaves the original decision unresolved.

## Todos, memory, and global instructions

- **Todos** — lunr-todos is a full-replace list. Completed todos prune on the next user turn (no leftover `✓ N done` footer).
- **Agent memory** — durable established facts and stable preferences in `~/.lunr/simple-memory/memory.md`. `/settings` → Agent memory controls injection and the `memory_add`, `memory_remove`, and `memory_load` tools without deleting stored facts. `memoryCharCap` defaults to 5000. Behavior instructions, transient task state, transcripts, guesses, and secrets do not belong in memory.
- **Global instructions** — create `~/.lunr/agent/agents/AGENTS.md` yourself when you want global behavior or instructions. lunR injects it through the normal context loader; `/reload` picks up changes. The model cannot modify this user-managed file. The retired `behavior.md` file and behavior presets are no longer loaded.
- **Model instructions** — `/settings` can enable `~/.lunr/agent/agents/<model-name>/AGENTS.md` and choose **Both** (global then model-specific) or **Model only**. The folder name is provider-independent and filesystem-safe. Project `AGENTS.md`/`CLAUDE.md` files are unaffected, and `--no-context-files` disables all instruction files.

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

- `/thinking`, `/effort`, and `/reasoning` are full-parity aliases. `/off`, `/minimal`, `/low`, `/medium`, `/high`, `/xhigh`, and `/max` set a level when the current model supports it. `/thinking` completions follow the session model. `xhigh` and `max` are opt-in. `/thinking hide|show|toggle` still hides thinking blocks.
- `/usage` is **this-session** context plus every stored-credential subscription plan. The current provider is included for env-only auth. There is no `/token-usage`.
- `/fast [on|off|status]` controls `service_tier: "fast"` for OpenAI Codex subscriptions only. It persists across new sessions, gateway turns, and subagents. Paid `openai` API models do not use it.
- Footer plan bar prefers a 5h window and falls back to weekly (`planUsageWindow`). In Customize, Plan usage hides the whole segment while Plan bar hides only the █░ fill and keeps the percent.
- Click a ✻ Thought or tool card to expand/collapse that item. `app.tools.expand` is unbound. `/tree` still uses `ctrl+o` for filters.
- Smooth streaming (`smoothStreaming`, default off) reveals assistant text and thinking in small character batches at about 30 FPS in the interactive TUI. The thinking preview shows the last four revealed lines. Completed thinking collapses after its reveal catches up. Message completion flushes any remaining text immediately. Print, RPC, and gateway stay unsmoothed.
- Image paste inserts `[image_n]` chips. Windows uses **Alt+V**; VS Code must forward it because it owns Ctrl+V and Alt+V. `/paste-image` bypasses terminal shortcuts.
- Model selection: every child launch chooses exactly one of `tier: light|standard|heavy` (default) or an explicit `model: provider/id` when the user names a model. Configure tier routes in `/settings`. Optional `thinking` is only valid with an explicit model; tier launches use configured tier thinking. Direct model launches do not require tier mode. Missing, both, inherit, unavailable, or unauthenticated selections fail closed before spawn.
- Settings changes stay on `/settings`. The agent does not get `settings_load` or other agent-managed settings tools, and direct file-tool writes to lunR `settings.json` are blocked.

## Updates, catalogs, local models

- `lunr update` / `lunr update --self` reinstalls global `@ashx-j/lunr` only. Workspace `npx lunr` is not a published install and will not self-update.
- Catalog refresh is `/refresh`. First paint is cache-only. `/model` lists stored-cred providers only.
- **xAI SuperGrok:** `/login xai` can import `~/.grok/auth.json` from the Grok CLI. `/logout xai` does not delete that file.
- **Ollama / LM Studio:** `/login` and select the local provider (localhost probe).
- **OpenCode Zen:** `/login opencode` then `/refresh`. Do not add a second Zen provider.

## Intercom and skill-creator

- **Intercom** — `/intercom` for the built-in intercom broker.
- **Skill-creator** — `/skill:skill-creator` (model invocation disabled by default). Global skills go in `~/.lunr/agent/skills/<name>/`; project skills in `.lunr/skills/<name>/` (requires trust).
