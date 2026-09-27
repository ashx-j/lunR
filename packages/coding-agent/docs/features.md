# Built-in features

lunR ships these workflows as baked-in extensions. You do not need a third-party package for MCP, subagents, planning, or todos.

Sample code under `examples/extensions/plan-mode`, `examples/extensions/todo.ts`, and `examples/extensions/subagent/` is **Extension API sample code**, not the product implementation.

## Permissions and planning

Permission modes: `yolo | auto | read-only`. Shift+Tab cycles in that order. The TUI labels read-only as `read` in its footer and settings. Ctrl+T cycles thinking levels.

- **yolo** auto-approves tools but still confirms large subagent launches. This is the default.
- **auto** runs without questions or large-launch confirmation.
- **read-only** permits investigation but blocks writes, full-access child launches, MCP tool calls, and unknown extension actions. MCP search and tool descriptions remain available. The shell command check is heuristic, not an OS sandbox.

Use `/read` or `/mode read` to inspect without changing files. `/plan` switches to read-only mode, and `/plan <task>` asks for a plan in that mode. If already read-only, `/plan <task>` stays read-only. Use `/plan off` to leave read-only mode. `present_plan` is available in read-only mode when a plan is needed. Approving a plan restores the previous mode before the tool result resolves, or enters yolo if no writable previous mode exists. Existing saved defaults migrate `manual` to `yolo` and `plan` to `read-only`.

## Subagents

`/settings` has two independent switches, both on by default. Automatic subagent delegation controls the built-in system prompt: off tells the agent to work directly and launch children only when you explicitly ask. Tier selection and other launch instructions remain available when you do ask. Custom system prompts and project instruction files are unchanged.

Subagent communication controls messages between a child and its parent while work is in progress. Off removes child `contact_supervisor` and `intercom`, parent questions and live steering for new children. Final results, status, cancellation, and `subagent_wait` still work. New launches and resumed children use the selected mode for their whole run, including queued steps. Turning it off blocks new parent questions and live steering immediately; already-running children retain their tools, and pending requests can still receive replies. The setting does not disable intercom between unrelated lunR sessions.

Advertised subagents always start **fresh** (no forked parent context). Default parallel concurrency / max tasks / global run cap are unlimited; an explicit `concurrency` is still honored.

Single, parallel, and chain launches run async when `async` is omitted. Set `async:false` for an immediate foreground result or use `clarify:true` for the interactive preview/editor. Continue independent work after an async launch, then yield for normal interactive completion. Use `subagent_wait` only when the same turn or skill must finish after its children. Headless sessions auto-drain current-session work. Use status for one-time inspection rather than polling or sleeping for completion.

In the interactive TUI, normal Enter during an executing `subagent_wait` releases only the parent's local wait. It does not stop background children or parallel sibling tools. After the current tool batch fully settles, lunR submits the text as a fresh parent prompt rather than a steering message. Alt+Enter remains a follow-up, and normal Enter outside `subagent_wait` remains steering while the parent works.

The legacy extension config keys `asyncByDefault` and `forceTopLevelAsync` remain accepted but no longer change launch mode. Omitted `async` resolves to async, while explicit `async:false`, `clarify:true`, and internal `foregroundOnly` calls stay foreground. RPC and scheduled launches remain always async.

Collapsed subagent rows (foreground and async) are one line: status glyph, description, selected tier or explicit model, tokens, and elapsed time. Mixed async runs use the same flat child rows without an aggregate tree. Running rows keep a live spinner and clock; completed collapsed rows freeze those stats. Choose the running child spinner under `/settings` → Customize. Async launches show `subagent async` in the tool header. Completed notify cards show title and status only; the model still receives the full result text.

A launch of 3+ parallel children in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls, receives one aggregate confirmation in **yolo**. Sequential work stays `chain`. Auto bypasses this confirmation, and it can be disabled independently in `/settings`.

`/goal` sets a session goal and **forces session auto** permission mode.

### Child communication

Children own reversible implementation choices within their assigned scope. Define file ownership and required outputs at launch. Establish a shared contract before dependent parallel work, then pass it through chain outputs or an artifact. Native child intercom reaches the supervisor only; it cannot discover or message siblings.

`contact_supervisor` separates delivery by purpose:

- `progress_update` records a UI-only entry. It never enters parent model context or starts a parent turn. Existing activity indicators usually make an explicit progress call unnecessary.
- `handoff` delivers actionable dependency findings or corrections without waiting for a reply. State what another task can now do, consolidate related findings, and reference one artifact for supporting detail. Continue independent work.
- `need_decision` and `interview_request` wait for a supervisor reply. Use them for decisions outside the child's authority, permission or safety concerns, and blockers. Include the blocked decision, evidence, and recommended choice.

Blocking requests and handoffs wake an idle parent. Headless waits yield to queued messages so a child can receive a decision before it finishes. Expired requests, stopped runs, and requests owned by another session cannot wake it. Legacy children retain model-facing progress delivery; UI-only progress requires the new protocol advertised by the spawning parent.

Inactivity and threshold notices stay in diagnostic entries rather than parent context or intercom relays. Repeated tool failures remain model-facing. Completion-guard diagnostics do not duplicate the normal terminal failure report.

Return one self-contained final report with outcomes, verification, blockers, and artifact paths. The runtime delivers it. A final report that only says findings were sent earlier is insufficient.

Communication cards are collapsed tool-style rows. Click to show `From` or `To`, the child's description, and the message. Routing IDs stay in structured diagnostics. Outgoing steering also shows its delivery state when expanded; delivery acknowledgement is not a model answer.

### Questions to async children

The parent can use `subagent_supervisor` with `action: "ask"` to ask a running async child for information it needs before the final report. The request names the run, selects one child, and includes a `reason` explaining which decision needs the answer.

Asking returns a question ID without waiting. The child receives the question at a safe turn boundary, replies from its current findings, and continues its assigned task. Answers arrive separately from the run's final result and wake an idle parent. A delivery receipt is not an answer. Questions do not change the assignment, broadcast to other children, or restart finished children.

The parent calls `subagent_supervisor({ action: "ask", id, index, reason, message })`. It must select an `index` or private `childId` when several children are running. The child answers with `contact_supervisor({ action: "reply", replyTo: questionId, message })`. If the parent's next decision must wait, `subagent_wait({ questionId })` returns the answer instead of sending a second notification. Read-only children can reply without receiving editing tools.

A child must have an active question-capable input channel. Only one question may be outstanding per child. Questions expire after ten minutes by default, and child termination, failed delivery, process replacement, or parent session replacement cancels pending questions. A wait timeout ends the wait, not the question. Existing blocking child-to-parent requests take priority to avoid mutual waiting.

The agent must ask only when the child has missing context, the answer changes a concrete next decision, and waiting for completion would block progress or risk rework. It must use available results first and batch related questions. Routine progress checks, duplicate questions, polling, and step-by-step supervision are prohibited. A follow-up is appropriate only when the answer leaves the original decision unresolved.

### Measuring communication cost

Compare the same task, models, thinking levels, and starting checkout before and after a communication change. Count parent wakeups by their triggering event, provider calls in both parent and child sessions, duplicate deliveries, input/output tokens, cache reads/writes, elapsed time, and blocked time. Check task correctness and delivery of required escalations before comparing cost. Cached input is separate from uncached input; fewer messages or a quieter UI alone do not establish savings. Keep transcript evidence local.

## Todos, memory, and global instructions

- **Todos** — lunr-todos is a full-replace list. `/settings` → Todos disables its system-prompt guidance, model-facing tool, and editor widget. Collapsed lists show all four active items; lists of five or more show three and a `+N more` line. Completed todos prune on the next user turn, so the footer does not leave a `✓ N done` line.
- **Agent memory** — durable established facts and stable preferences in `~/.lunr/simple-memory/memory.md`. `/settings` → Agent memory controls injection and the `memory_add`, `memory_remove`, and `memory_load` tools without deleting stored facts. `memoryCharCap` defaults to 5000. Behavior instructions, transient task state, transcripts, guesses, and secrets do not belong in memory.
- **Global instructions** — create `~/.lunr/agent/agents/AGENTS.md` yourself when you want global behavior or instructions. lunR injects it through the normal context loader; `/reload` picks up changes. The model cannot modify this user-managed file. The retired `behavior.md` file and behavior presets are no longer loaded.
- **Model instructions** — `/settings` can enable `~/.lunr/agent/agents/<model-name>/AGENTS.md` and choose **Both** (global then model-specific) or **Model only**. The folder name is provider-independent and filesystem-safe. Project `AGENTS.md`/`CLAUDE.md` files are unaffected, and `--no-context-files` disables all instruction files.

## Cron

`/cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status`

Jobs persist in `~/.lunr/agent/cron/` (`jobs.json`). Interactive TUI cron runs in the live session. `lunr gateway` runs the same scheduler with a fresh headless session. TUI cron uses the same deliver allowlist as the gateway.

`cronFallbackModels` in settings is a hand-edited list of `provider/modelId` entries tried in order when a gateway cron fire fails.

Schedule examples: `every 30m`, `every 2h`, `every 1d`, a duration one-shot (`30m`), an ISO timestamp, or a 5-field cron expression.

## Gateway for Telegram and Discord

Run `lunr gateway setup` in your terminal. Use Up/Down and Enter to choose the platform, saved token and owner options, default project, startup preference, provider, and model. Long lists scroll; Escape cancels. Only a new bot token, user ID, or custom folder path needs typing. Token entry stays hidden. Setup explains bot creation, validates the bot identity, and asks before saving or starting the gateway. Log in to a model provider locally with `/login` first. Setup does not create model-provider accounts.

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

Owner access includes local projects and saved TUI conversation history. Ordinary `lunr gateway pair approve <platform> <code>` grants chat access only; add `--owner` locally to grant owner access. Ordinary pairing, group access, and Discord roles do not grant it. Project browsing, cross-project sessions, permission changes, and file downloads require an explicitly configured owner in a private DM. Removing owner access invalidates later owner actions and approvals.

### Projects and mobile controls

The owner can send `/start` to check setup before the first task, `/model` to select an authenticated model before a task, and a normal message immediately when setup's default project remains approved. With multiple approved roots and no explicit default, choose `/project` first. A paired non-owner without a project must ask the local owner to configure access; `/project` and `/continue` are owner-only. Use `/project` to browse approved roots, open child folders, go back, select a folder, or create one. `/project <path>` opens the browser at an approved path. The gateway remembers the selected working directory for that conversation. Project instruction files, skills, tools, and trust checks use that directory rather than the daemon's launch directory.

**The selected project is a working directory, not a shell sandbox.** Shell commands and tools can access other locations allowed by your OS account. The folder browser and `/download` check their own path boundaries, including symlinks.

- `/model`, `/thinking`, `/settings`, and `/mode` control the active session. `/fast` controls Codex fast mode.
- `/plan <task>` starts planning. The plan appears in chat with approval buttons. Approval returns the session to yolo mode.
- `/goal`, `/cron`, `/run`, `/chain`, and `/parallel` use the same built-in extensions as the terminal. Pass arguments when an extension's interactive editor requires the terminal.
- `/skill` selects a loaded skill and asks for a task. `/mcp` and `/lsp` expose their text status commands; the agent retains the configured coding tools.
- `/usage` reports session tokens and provider-plan usage. `/status` includes the selected project.
- `/stop` aborts the current turn and pending transfer. `/stopall` also requests cancellation of background subagents and tracked shell processes. `/processes` lists this session's processes; `/processes stop <pid>` requests a stop.
- `/cancel` cancels a pending selection or transfer. `/new` aborts the current turn and drops queued input, but refuses to discard a session that still has attached background work.

Upload images or documents in chat. Images reach the model as images; documents are saved under the project's `.lunr/uploads/` directory and passed to the model as paths. `/download <project-relative path>` sends a file back. Files are limited to 8 MB; common credential filenames are blocked from download. This filename check is not a content-based secret scanner. Only send files you intend to share with the chat platform.

Foreground replies, follow-up answers, errors, and extension notices enter a disk-backed outbox before sending. Successfully sent chunks are acknowledged in order; failed sends retry up to five times per destination without blocking other chats. A failed final preview edit falls back to a full reply. Permanently failed deliveries remain in `gateway-outbox.json` with `failed: true` and an error in gateway logs for diagnosis; they do not retry forever. A send can still reach the platform just before the process exits without recording its acknowledgement, so a restart can repeat that chunk. Existing outbox entries without the newer fields remain eligible for delivery. Session changes cancel stale interactive prompts and notices, but finished assistant results still reach their originating chat when authorized. Revoked access prevents delivery. Discord role-only authorization needs a fresh inbound role check after restart before it can authorize new sends; an old stored role assertion cannot authorize outbox replay. Tool approvals, pickers, and text questions do not become model prompts; they expire when the session changes. Terminal-only custom screens report that limitation rather than pretending they accepted a selection.

### Continue between desktop and phone

In the terminal, `/handoff` marks the current saved session for eight hours. Repeat it to refresh the mark; `/handoff cancel` removes it. Unsaved sessions must be persisted first.

On your phone, `/continue` opens the only marked session, or offers a picker if several are marked. Without an active mark, it selects the latest TUI activity. TUI activation, user prompts, and state-changing user commands count as activity. Background results and file timestamps do not. Closed TUI sessions remain eligible.

`/sessions [filter]` browses saved sessions across projects, including locally registered custom session paths. It works before you have sent the bot its first task. Continuation preserves the session file, selected conversation branch, original project directory, and permission checkpoint. Resuming `auto` or `yolo` asks for confirmation on the phone and defaults to read-only if declined.

Only one updated lunR process may write a persistent session at a time. A running owner must release it cooperatively. If it is busy, choose Wait, Stop and continue, or Cancel. Wait retries busy requests for up to two minutes. Stop and continue aborts the foreground turn; it does not migrate children or shell processes. Those must finish or actually stop before transfer. Cancellation stops pending acquisition, but cannot undo extension shutdown once release has begun.

A detached terminal keeps its draft and can use `/reclaim` to reopen fresh state after the phone releases ownership. It does not append from its old in-memory conversation. Marks remain until expiry or cancellation, even after a successful continuation. Expiry only removes the preference; it neither deletes the conversation nor disconnects it.

All concurrent writers must use a lunR version with session ownership support. Old versions and external file editors cannot honor these locks. Recovery only clears an owner after verified local process death. Uncertain, foreign-host, or incomplete ownership records fail closed; inspect them rather than deleting a live lock.

## MCP, LSP, web search

- **MCP** — `/mcp`, `/mcp-auth`. Footer MCP segment is on by default (`footerMcp`).
- **LSP** — `/lsp`, `/lsp-restart`, `/lsp-config`. Footer LSP segment is off by default (`footerLsp`). On Windows, npm `.cmd` shims need a real LSP start (`shell: true`); if the server never starts, tools silently fall back to tree-sitter. Check `/lsp` if language features look missing.
- **Web search** — `/websearch` (and related search commands). Interactive TUI attaches web-access after first paint; print/RPC/gateway load it before the first turn.

## Headless browser

The first-party `browser` tool is on by default. Normal installation and updates install matching Chromium automatically. Browser in `/settings` turns the tool off and closes active contexts immediately; cached binaries remain. Offline or ignored-script installs can recover later with `lunr browser install`. Startup and tool execution never install Chromium. The browser handles JavaScript-rendered pages and accessible website interactions, while `web_search` remains discovery and `fetch_content` remains URL reading. There is no automatic browser fallback.

The browser uses ephemeral session-owned contexts. Read-only mode blocks interactions. Yolo and auto allow them without per-action approval. Public HTTP(S) is the default; local/private access requires explicit user configuration. Website effects cannot be reversed by `/undo`.

See [Headless browser](browser.md) for action parameters, installation exceptions, legacy setting precedence, private-network risks, lifecycle limits, and validation.

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
