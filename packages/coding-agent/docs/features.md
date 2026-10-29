# Built-in features

lunR ships these workflows as baked-in extensions. You do not need a third-party package for MCP, subagents, planning, or todos.

Sample code under `examples/extensions/plan-mode`, `examples/extensions/todo.ts`, and `examples/extensions/subagent/` is **Extension API sample code**, not the product implementation.

PR watching polls GitHub every minute without model calls during quiet cycles. The `pr_watch` tool starts or waits on a session-owned finite watch. Set its duration in `/settings`; use `/pr-watch` to view, cancel, or restart watches. A new head resets the original duration. Monitoring ends at its deadline, PR completion, or user cancellation and never declares the PR ready. See [PR watching](pr-watch.md).

## Permissions and planning

Permission modes: `yolo | auto | read-only`. Shift+Tab cycles in that order. The TUI labels read-only as `read` in its footer and settings. Ctrl+T cycles thinking levels.

- **yolo** auto-approves tools. Large subagent launch confirmation is optional and off by default. This is the default mode.
- **auto** has a review model check each risky action before it runs, the way Claude Code, Codex, Grok Build and Qwen Code do in their own auto modes. Reads, informational shell commands, edits inside the project, todos and goal updates run straight away. Other shell commands, writes outside the project, MCP calls, browser and computer actions, cron changes and full-access subagent launches go to the reviewer first. The reviewer sees what you asked for, the agent's earlier actions this turn and the pending action, but never tool output, so text in files or web pages can't argue with it. A blocked action returns the reviewer's reason to the model. After 3 blocks in a row or 20 in a session, lunR asks you instead, and cron or `-p` runs keep the action blocked. Each review is one extra request and appears in `/usage`.
- **Which model reviews.** Anthropic sessions use Claude Sonnet 5, Claude Code's own reviewer, falling back to the session model when Sonnet 5 isn't available. OpenAI (API and Codex), xAI and Qwen sessions use the session model at low reasoning effort, since their agents don't name one. Other providers' own agents offer no reviewer, so entering auto warns you and opens the model list to pick one. `/settings` → Auto review model changes or resets the choice. Without a usable reviewer, auto asks you before each risky action.
- **No questions** is separate from the permission mode. `/goal`, subagents and the ACP Autonomous mode work without stopping to ask you and skip the large-launch confirmation. Subagents follow their parent's mode: reviewed in auto, unreviewed in yolo.
- **read-only** permits investigation but blocks writes, full-access child launches, MCP tool calls, and unknown extension actions. MCP search and tool descriptions remain available. Shell calls permit known informational forms. Project scripts and tests such as `npm test`, package executors, interpreter execution, and unknown Git operations require a writable mode. The shell command check is heuristic, not an OS sandbox.

Use `/mode read` to inspect without changing files. `/plan` switches to read-only mode, and `/plan <task>` asks for a plan in that mode. If already read-only, `/plan <task>` stays read-only. Use `/plan off` to leave read-only mode. `present_plan` is available in read-only mode when a plan is needed. Approving a plan restores the previous mode before the tool result resolves, or enters yolo if no writable previous mode exists.

## Subagents

`/settings` has two independent switches, both on by default. Automatic subagent delegation controls the built-in system prompt: off tells the agent to work directly and launch children only when you explicitly ask. Tier selection and other launch instructions remain available when you do ask. Custom system prompts and project instruction files are unchanged.

Subagent communication controls messages between a child and its parent while work is in progress. Off removes child `contact_supervisor` and `intercom`, parent questions and live steering for new children. Final results, status, cancellation, and `subagent_wait` still work. New launches and resumed children use the selected mode for their whole run, including queued steps. Turning it off blocks new parent questions and live steering immediately; already-running children retain their tools, and pending requests can still receive replies. The setting does not disable intercom between unrelated lunR sessions.

Advertised subagents always start **fresh** (no forked parent context). Default parallel concurrency / max tasks / global run cap are unlimited; an explicit `concurrency` is still honored.

Single, parallel, and chain launches run async when `async` is omitted. Set `async:false` for an immediate foreground result or use `clarify:true` for the interactive preview/editor. Continue independent work after an async launch, then yield for normal interactive completion. Use `subagent_wait` only when the same turn or skill must finish after its children. Headless sessions auto-drain current-session work. Use status for one-time inspection rather than polling or sleeping for completion.

In the interactive TUI, normal Enter during an executing `subagent_wait` releases only the parent's local wait. It does not stop background children or parallel sibling tools. After the current tool batch fully settles, lunR submits the text as a fresh parent prompt rather than a steering message. Alt+Enter remains a follow-up, and normal Enter outside `subagent_wait` remains steering while the parent works.

The legacy extension config keys `asyncByDefault` and `forceTopLevelAsync` remain accepted but no longer change launch mode. Omitted `async` resolves to async, while explicit `async:false`, `clarify:true`, and internal `foregroundOnly` calls stay foreground. RPC and scheduled launches remain always async.

`/prompt-workflow <name> [args]` runs a prompt workflow with a declared `tier` through native subagents. `/chain analyze -> fix -- auth --foreground` runs those workflows as a native chain with shared arguments. Omit `--foreground` to run in the background. Use `/prompt-workflow list` to list available workflows.

`/chain analyze -> fix --loop 3 --chain-context` runs prompt templates through the separate prompt-template engine. It supports template model selection, loops, and delegated step summaries. The optional `run-prompt` tool uses this same engine and queues commands until the current turn ends. A successful queue receipt confirms acceptance. Disabled, busy, uninitialized, empty, or already-queued requests return tool errors. `/prompt-tool on` enables the tool, and `/prompt-tool off` disables it.

`/chain` picks its engine from the arguments. A first step with inline `[tier=...]` or `[model=...]` config, or one that opens a `(` parallel group, runs a subagent task chain, so a task step named like a workflow always stays a task chain. Otherwise, when every step is a single workflow name, it runs those workflows; when every step names a prompt template, it runs the template chain. Anything else is treated as a task chain and gets its usual usage error. A workflow wins when a name is both. `/chain-workflows` and `/chain-prompts` still work as hidden aliases for one release.

Collapsed subagent rows (foreground and async) are one line: status glyph, description, selected tier or explicit model, tokens, and elapsed time. Mixed async runs use the same flat child rows without an aggregate tree. Running rows keep a live spinner and clock; completed collapsed rows freeze those stats. Choose the running child spinner under `/settings` → Customize. Async launches show `subagent async` in the tool header. Completed notify cards show title and status only; the model still receives the full result text.

Enable Confirm big subagent launches in `/settings` to receive one aggregate confirmation in **yolo** for 3+ parallel children in one `tasks`/`chain.parallel` call, or 3+ same-turn SINGLE `subagent` calls. This setting is off by default. Sequential work stays `chain`. Auto, where the reviewer checks full-access launches, and sessions that work without questions (`/goal`, subagents, ACP Autonomous) bypass confirmation even when the setting is enabled.

`/goal` sets a session goal and makes the session work without asking questions, keeping your permission mode. A read-only session switches to yolo for the goal and back afterwards.

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

## Token usage

`/usage` and `/session` separate parent requests, completed child receipts, and their combined total. Input includes ordinary input, cache reads, and cache writes. Output includes reasoning when the provider reports it. Summary and automatic-title requests count as parent requests even though their text does not enter the chat. Goal token budgets use parent and child totals and retain consumed tokens after branch navigation.

Child totals include failed fallback attempts and auxiliary requests. Completion notifications, waits, and resumed sessions deduplicate requests rather than charging the same history again. A fork retains the conversation as context but starts with zero newly incurred usage. Children still running may not have supplied their final receipt yet.

Current context and its visible-thinking breakdown are estimates of the next request. They include the system prompt and tool definitions, and exclude `!!` shell output. The `~` footer marker means the context count includes an estimate. Image sizes, provider formatting, and hidden reasoning can differ from local estimates. Cache-miss estimates describe inferred overlap, not measured waste.

Costs use a provider's reported charge when available, otherwise catalog prices. Subscription quota remains the provider's account measurement and can be cached for up to 60 seconds. Missing or incomplete usage is labeled separately from reported zero. Older sessions cannot recover requests or breakdowns that were never recorded.

## Todos, memory, and global instructions

- **Todos** — lunr-todos is a full-replace list. `/settings` → Todos disables its system-prompt guidance, model-facing tool, and editor widget. Collapsed lists show all four active items; lists of five or more show three and a `+N more` line. Completed todos prune on the next user turn, so the footer does not leave a `✓ N done` line.
- **Agent memory** — durable established facts and stable preferences in `~/.lunr/simple-memory/memory.md`. `/settings` → Agent memory controls injection and the `memory_add`, `memory_remove`, and `memory_load` tools without deleting stored facts. `memoryCharCap` defaults to 5000. Behavior instructions, transient task state, transcripts, guesses, and secrets do not belong in memory.
- **Global instructions** — create `~/.lunr/agent/agents/AGENTS.md` yourself when you want global behavior or instructions. lunR injects it through the normal context loader; `/reload` picks up changes. The model cannot modify this user-managed file.
- **Model instructions** — `/settings` can enable `~/.lunr/agent/agents/<model-name>/AGENTS.md` and choose **Both** (global then model-specific) or **Model only**. The folder name is provider-independent and filesystem-safe. Project `AGENTS.md`/`CLAUDE.md` files are unaffected, and `--no-context-files` disables all instruction files.

## Cron

`/cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status`

Jobs persist in `~/.lunr/agent/cron/` (`jobs.json`) and run only while a TUI is open. One TUI owns scheduling for a profile until its work and shutdown settle, and admits a turn only when its live session is idle. Each job runs in the project it was created in; a TUI open in another project leaves it due for one open in the right project. Output is saved under `~/.lunr/agent/cron/output/`. A nonowner manual run returns an owner conflict.

After a crash during started work, the next owner pauses that job with an unknown-effects error. Inspect its effects before using `/cron run` to retry deliberately. Timeout and stop cancel the owned request and wait for cleanup before recording one terminal result or releasing ownership.

Schedule examples: `every 30m`, `every 2h`, `every 1d`, a duration one-shot (`30m`), an ISO timestamp, or a 5-field cron expression.

## MCP, LSP, web search

- **MCP** — `/mcp`, `/mcp-auth`. Footer MCP segment is on by default (`footerMcp`).
- **LSP** — `/lsp`, `/lsp-restart`, `/lsp-config`. Footer LSP segment is off by default (`footerLsp`). On Windows, npm `.cmd` shims need a real LSP start (`shell: true`); if the server never starts, tools silently fall back to tree-sitter. Check `/lsp` if language features look missing.
- **Web search** — `/search <query>[, query...]` opens the search curator; `/search` alone lists stored results. Interactive TUI attaches web-access after first paint; print/RPC load it before the first turn.

Stored web results belong to the current session. `get_search_content` returns pages of at most 50 KiB and 2,000 lines, including selector lists and errors. Start with `responseId` and a query or URL selector. If the page is truncated, repeat the same call with `offset` set to the returned `nextOffset`. Offsets count UTF-8 bytes. Direct HTTP extraction limits decoded bodies to 5 MiB for text and 20 MiB for PDFs before parsing.

## Headless browser

The first-party `browser` tool is on by default. Normal installation and updates install matching Chromium automatically. Browser in `/settings` turns the tool off and closes active contexts immediately; cached binaries remain. Offline or ignored-script installs can recover later with `lunr browser install`. Startup and tool execution never install Chromium. The browser handles JavaScript-rendered pages and accessible website interactions, while `web_search` remains discovery and `fetch_content` remains URL reading. There is no automatic browser fallback.

The browser uses ephemeral session-owned contexts. Read-only mode blocks interactions. Yolo and auto allow them without per-action approval. Public HTTP(S) is the default; local/private access requires explicit user configuration. Website effects cannot be reversed by `/undo`.

See [Headless browser](browser.md) for action parameters, installation exceptions, legacy setting precedence, private-network risks, lifecycle limits, and validation.

## Computer use

`/computer setup` installs the bundled runtime for image-only desktop control on Windows and Apple Silicon macOS. Setup is unavailable in headless sessions, and the computer tools need an image-capable model. See [Computer use](computer-use.md) for permissions and limits.

## Thinking, usage, streaming, UI

- `/thinking <level>` sets the level when the current model supports it; `/effort` and `/reasoning` are hidden aliases. `/thinking` completions follow the session model. `xhigh` and `max` are opt-in. `/thinking hide|show|toggle` still hides thinking blocks.
- `/usage` is **this-session** context plus every stored-credential subscription plan. The current provider is included for env-only auth.
- `/fast [on|off|status]` controls `service_tier: "fast"` for OpenAI Codex subscriptions only. It persists across new sessions and subagents. Paid `openai` API models do not use it.
- Footer plan bar prefers a 5h window and falls back to weekly (`planUsageWindow`). In Customize, Plan usage hides the whole segment while Plan bar hides only the █░ fill and keeps the percent.
- `/settings` Notifications (default off) rings the terminal bell or sends a desktop notification when a run finishes or stops for an approval or question. lunR asks the terminal for focus reports and stays quiet while you are looking at it; terminals without focus reports get every notice. Desktop notices use OSC 9, which iTerm2, WezTerm and Ghostty show. Other terminals ignore it, so pick the bell there.
- Click a ✻ Thought or tool card to expand/collapse that item. `app.tools.expand` is unbound. `/tree` still uses `ctrl+o` for filters.
- Smooth streaming (`smoothStreaming`, default off) reveals assistant text and thinking in small character batches at about 30 FPS in the interactive TUI. The thinking preview shows the last four revealed lines. Completed thinking collapses after its reveal catches up. Message completion flushes any remaining text immediately. Print and RPC stay unsmoothed.
- Image paste inserts `[image_n]` chips. Windows uses **Alt+V**; VS Code must forward it because it owns Ctrl+V and Alt+V. `/paste-image` bypasses terminal shortcuts.
- Model selection: every child launch chooses exactly one of `tier: light|standard|heavy` (default) or an explicit `model: provider/id` when the user names a model. Configure tier routes in `/settings`. Optional `thinking` is only valid with an explicit model; tier launches use configured tier thinking. Direct model launches do not require tier mode. Missing, both, inherit, unavailable, or unauthenticated selections fail closed before spawn.
- Settings changes stay on `/settings`. The agent does not get `settings_load` or other agent-managed settings tools, and direct file-tool writes to lunR `settings.json` are blocked.

## Updates, catalogs, local models

- `lunr update` / `lunr update --self` reinstalls global `@ashx-j/lunr` only.
- Catalog refresh is `/refresh`. First paint is cache-only. `/model` lists stored-cred providers only.
- **xAI SuperGrok:** `/login xai` can import `~/.grok/auth.json` from the Grok CLI. `/logout xai` does not delete that file.
- **Ollama / LM Studio:** `/login` and select the local provider (localhost probe).
- **OpenCode Zen:** `/login opencode` then `/refresh`.

## Intercom and skill-creator

- **Intercom** — `/intercom` for the built-in intercom broker.
- **Skill-creator** — `/skill:skill-creator` (model invocation disabled by default). Global skills go in `~/.lunr/agent/skills/<name>/`; project skills in `.lunr/skills/<name>/` (requires trust).
