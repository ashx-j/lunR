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

Single, parallel, and chain launches run async when `async` is omitted. Set `async:false` for an immediate foreground result or use `clarify:true` for the interactive preview/editor. Continue independent work after an async launch, then yield for normal interactive completion. Use `subagent_wait` only when the same turn or skill must finish after its children. Headless sessions auto-drain current-session work. Use status for one-time inspection rather than polling or sleeping for completion.

The legacy extension config keys `asyncByDefault` and `forceTopLevelAsync` remain accepted but no longer change launch mode. Omitted `async` resolves to async, while explicit `async:false`, `clarify:true`, and internal `foregroundOnly` calls stay foreground. RPC and scheduled launches remain always async.

Collapsed subagent rows (foreground and async) are one line: status glyph, description, selected tier or explicit model, tokens, and elapsed time. Mixed async runs use the same flat child rows without an aggregate tree. Running rows keep a live spinner and clock; completed collapsed rows freeze those stats. Choose the running child spinner under `/settings` → Customize. Async launches show `subagent async` in the tool header. Completed notify cards show title and status only; the model still receives the full result text.

A launch of 3+ parallel children in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls, receives one aggregate confirmation in **manual and yolo**. Sequential work stays `chain`. Auto bypasses this confirmation, and it can be disabled independently in `/settings`.

`/goal` sets a session goal and **forces session auto** permission mode.

### Questions to async children

The parent can use `subagent_supervisor` with `action: "ask"` to ask a running async child for information it needs before the final report. The request names the run, selects one child, and includes a `reason` explaining which decision needs the answer.

Asking returns a question ID without waiting. The child receives the question at a safe turn boundary, replies from its current findings, and continues its assigned task. Answers arrive separately from the run's final result and wake an idle parent. A delivery receipt is not an answer. Questions do not change the assignment, broadcast to other children, or restart finished children.

The parent calls `subagent_supervisor({ action: "ask", id, index, reason, message })`. It must select an `index` or private `childId` when several children are running. The child answers with `contact_supervisor({ action: "reply", replyTo: questionId, message })`. If the parent's next decision must wait, `subagent_wait({ questionId })` returns the answer instead of sending a second notification. Read-only children can reply without receiving editing tools.

A child must have an active question-capable input channel. Only one question may be outstanding per child. Questions expire after ten minutes by default, and child termination, failed delivery, process replacement, or parent session replacement cancels pending questions. A wait timeout ends the wait, not the question. Existing blocking child-to-parent requests take priority to avoid mutual waiting.

The agent must ask only when the child has missing context, the answer changes a concrete next decision, and waiting for completion would block progress or risk rework. It must use available results first and batch related questions. Routine progress checks, duplicate questions, polling, and step-by-step supervision are prohibited. A follow-up is appropriate only when the answer leaves the original decision unresolved.

## Todos, memory, and global instructions

- **Todos** — lunr-todos is a full-replace list. Collapsed lists show all four active items; lists of five or more show three and a `+N more` line. Completed todos prune on the next user turn (no leftover `✓ N done` footer).
- **Agent memory** — durable established facts and stable preferences in `~/.lunr/simple-memory/memory.md`. `/settings` → Agent memory controls injection and the `memory_add`, `memory_remove`, and `memory_load` tools without deleting stored facts. `memoryCharCap` defaults to 5000. Behavior instructions, transient task state, transcripts, guesses, and secrets do not belong in memory.
- **Global instructions** — create `~/.lunr/agent/agents/AGENTS.md` yourself when you want global behavior or instructions. lunR injects it through the normal context loader; `/reload` picks up changes. The model cannot modify this user-managed file. The retired `behavior.md` file and behavior presets are no longer loaded.
- **Model instructions** — `/settings` can enable `~/.lunr/agent/agents/<model-name>/AGENTS.md` and choose **Both** (global then model-specific) or **Model only**. The folder name is provider-independent and filesystem-safe. Project `AGENTS.md`/`CLAUDE.md` files are unaffected, and `--no-context-files` disables all instruction files.

## Cron

`/cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status`

Jobs persist in `~/.lunr/agent/cron/` (`jobs.json`). Interactive TUI cron runs in the live session. `lunr gateway` runs the same scheduler with a fresh headless session. TUI cron uses the same deliver allowlist as the gateway.

`cronFallbackModels` in settings is a hand-edited list of `provider/modelId` entries tried in order when a gateway cron fire fails.

Schedule examples: `every 30m`, `every 2h`, `every 1d`, a duration one-shot (`30m`), an ISO timestamp, or a 5-field cron expression.

## Gateway for Telegram and Discord

Run `lunr gateway setup` in your terminal. It explains bot creation and permissions, masks token entry, validates the bot identity, and asks for your user ID, project roots, saved model, and startup preference. Log in to a model provider locally with `/login` first. Setup does not create model-provider accounts.

Telegram uses BotFather and long polling. Discord needs the bot and `applications.commands` installation scopes. Enable Message Content Intent for ordinary text messages. GuildMembers intent is not required. Discord registers native slash commands; Telegram registers a command menu. Both platforms use buttons for selections and approvals.

Your computer must stay awake and online. Startup cannot make a sleeping or disconnected computer available.

### Service controls

```bash
lunr gateway setup
lunr gateway start
lunr gateway stop
lunr gateway restart
lunr gateway status
lunr gateway logs
lunr gateway doctor
lunr gateway run
lunr gateway autostart login
lunr gateway autostart boot
lunr gateway autostart off
```

Bare `lunr gateway` also runs in the foreground. The terminal's `/settings` Gateway menu opens setup, service controls, logs, and diagnostics.

Login startup runs after you sign in. Boot startup runs before login and may require administrator approval or OS-managed account credentials. Linux uses a systemd user service, with lingering for boot startup. macOS uses a LaunchAgent for login or a LaunchDaemon running as your user for boot. Windows uses Scheduled Tasks; its boot option asks Windows to obtain the account credentials rather than saving the password in lunR. lunR checks the native installation command before recording a successful startup change. Changing or disabling startup removes the previous lunR service, not other applications' services.

Encrypted home directories, missing user-service support, network restrictions, and OS permissions can prevent boot startup. Use `status`, `doctor`, and `logs` to check the installed service and bot connections. Service definitions are separate for each lunR profile. Native startup specifications have automated tests; installing and rebooting services on all three operating systems still requires host verification.

### Owner access

Configuration lives in `~/.lunr/agent/gateway.json` and may contain bot tokens. It is written with mode 0600 where supported; Windows security follows the profile directory's ACL. Tokens are not stored in `install-features.json` or startup command arguments. Environment tokens override file tokens in this order: `LUNR_<PLATFORM>_BOT_TOKEN`, then `<PLATFORM>_BOT_TOKEN`.

If you skipped your user ID during setup, message the bot privately and approve its pairing code locally:

```bash
lunr gateway pair approve telegram <code> --owner
lunr gateway pair approve discord <code> --owner
lunr gateway pair list
```

Owner access includes local projects and saved TUI conversation history. Ordinary pairing, group access, and Discord roles do not grant it. Project browsing, cross-project sessions, permission changes, and file downloads require an explicitly configured owner in a private DM. Removing owner access invalidates later owner actions and approvals.

### Projects and mobile controls

Use `/project` to browse approved roots, open child folders, go back, select a folder, or create one. `/project <path>` opens the browser at an approved path. The gateway remembers the selected working directory for that conversation. Project instruction files, skills, tools, and trust checks use that directory rather than the daemon's launch directory.

**The selected project is a working directory, not a shell sandbox.** Shell commands and tools can access other locations allowed by your OS account. The folder browser and `/download` check their own path boundaries, including symlinks.

- `/model`, `/thinking`, `/settings`, and `/mode` control the active session. `/fast` controls Codex fast mode.
- `/plan <task>` starts planning. The plan appears in chat with approval buttons. Approval returns the session to manual mode.
- `/goal`, `/cron`, `/run`, `/chain`, and `/parallel` use the same built-in extensions as the terminal. Pass arguments when an extension's interactive editor requires the terminal.
- `/skill` selects a loaded skill and asks for a task. `/mcp` and `/lsp` expose their text status commands; the agent retains the configured coding tools.
- `/usage` reports session tokens and provider-plan usage. `/status` includes the selected project.
- `/stop` aborts the current turn and pending transfer. `/stopall` also requests cancellation of background subagents and tracked shell processes. `/processes` lists this session's processes; `/processes stop <pid>` requests a stop.
- `/cancel` cancels a pending selection or transfer. `/new` aborts the current turn and drops queued input, but refuses to discard a session that still has attached background work.

Upload images or documents in chat. Images reach the model as images; documents are saved under the project's `.lunr/uploads/` directory and passed to the model as paths. `/download <project-relative path>` sends a file back. Files are limited to 8 MB; common credential filenames are blocked from download. This filename check is not a content-based secret scanner. Only send files you intend to share with the chat platform.

Extension notices and background results reach the originating conversation even after the foreground answer. Undelivered notices persist for retry. Tool approvals, pickers, and text questions do not become model prompts; they expire when the session changes. Terminal-only custom screens report that limitation rather than pretending they accepted a selection.

### Continue between desktop and phone

In the terminal, `/handoff` marks the current saved session for eight hours. Repeat it to refresh the mark; `/handoff cancel` removes it. Unsaved sessions must be persisted first.

On your phone, `/continue` opens the only marked session, or offers a picker if several are marked. Without an active mark, it selects the latest TUI activity. TUI activation, user prompts, and state-changing user commands count as activity. Background results and file timestamps do not. Closed TUI sessions remain eligible.

`/sessions [filter]` browses saved sessions across projects, including locally registered custom session paths. It works before you have sent the bot its first task. Continuation preserves the session file, selected conversation branch, original project directory, and permission checkpoint. Resuming `auto` or `yolo` asks for confirmation on the phone and defaults to manual if declined.

Only one updated lunR process may write a persistent session at a time. A running owner must release it cooperatively. If it is busy, choose Wait, Stop and continue, or Cancel. Wait retries busy requests for up to two minutes. Stop and continue aborts the foreground turn; it does not migrate children or shell processes. Those must finish or actually stop before transfer. Cancellation stops pending acquisition, but cannot undo extension shutdown once release has begun.

A detached terminal keeps its draft and can use `/reclaim` to reopen fresh state after the phone releases ownership. It does not append from its old in-memory conversation. Marks remain until expiry or cancellation, even after a successful continuation. Expiry only removes the preference; it neither deletes the conversation nor disconnects it.

All concurrent writers must use a lunR version with session ownership support. Old versions and external file editors cannot honor these locks. Recovery only clears an owner after verified local process death. Uncertain, foreign-host, or incomplete ownership records fail closed; inspect them rather than deleting a live lock.

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
