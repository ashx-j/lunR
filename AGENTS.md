# lunR

Custom CLI coding agent derived from pi. Builtin theme: `moon`. Roadmap: TUI ✓ features ✓ cron ✓ gateway ✓ (Discord/Telegram).

## Layout

lunR IS the git root. `pi/`, `hermes-agent/`, `kimi-cli/`, `extension-repos/` are gitignored study material — never import.

```
packages/tui · packages/ai · packages/agent · packages/coding-agent (bin lunr → dist/cli.js) · packages/orchestrator
```

## Toolchain

TypeScript ESM. Build order: tui → ai → agent → coding-agent → orchestrator (`npx tsgo -p <pkg>/tsconfig.build.json`). **Never `npm run build` in `packages/ai`** (generate-models catalog drift). Lint: `biome check packages/` (excludes `builtin-extensions/` + `*.generated.ts`). Tests: `vitest --run` (ai, agent, coding-agent), `node --test` (tui). Themes: JSON in `coding-agent/src/modes/interactive/theme/`.

## Agent rules

Read this file first; ask when ambiguous; touch only the task; small why-commits. No drive-by rewrites; check existing deps before adding. Never commit secrets; never force-push shared branches; confirm destructive git. Branch + PR before merge. Public docs: no local setup/secrets. Whenever an agent-facing tool is added, removed, renamed, conditionally registered, or materially changes purpose, keep its structured description/schema and conditional result guidance accurate, update tool-coverage tests, and regenerate the system-prompt inventory/snapshot when affected. Add always-injected base-prompt guidance only when the model needs it before its first tool call. **This file is the source of truth — after work update Current State + build/test, append Decisions (one-line why), gotchas under Notes. Delete stale entries. Committed detail lives in git log.**

---

# Current State

- **v0.2.38 (prepared 2026-10-18):** integration PR #208 merges PRs #195 to #207. Earlier releases and per-PR history: git log.
- **In 0.2.38:** Removed `/share`, the subagent `share` option, the unbuilt `shadow-git` rollback mode, dead upstream code and assets, the unreachable first-run analytics screen and two pi easter eggs. Added terminal notifications, `lunr doctor`, and reviewed auto mode with "no questions" split into its own session flag. Fixed `PI_OFFLINE=0`, leftover Pi naming and read mode's handling of `rg --pre`, `git grep -O`, `find -fprint`/`-fls`, `uniq` output files and code-running env prefixes. Type checking is on for 77 pi-subagents files; 39 still carry `@ts-nocheck` (475 errors, mostly `subagent-executor.ts` and `subagent-runner.ts`).
- **Planned mascot - cat (2.A):** TUI cat fits kitty spinners `₍^. .^₎⟆` / `(ㅅ´ ˘ `)`. Minimal 2-line. Not yet wired.
  ```
     /\_/\
    ( ˃ᴗ˂ )
  ```

Last updated: 2026-10-18 (trimmed shipped history). Public npm is `@ashx-j/lunr@0.2.37` until v0.2.38 publishes. **NEVER MERGE `archive/extension-absorption-DO-NOT-MERGE`.** Untracked locals: `prompts/`, `DESIGN.md`, `LUNR_SYSTEM_INJECTION.md`, `lunR-checklist.md`, `.pi-subagents/`.

## Installer

- **Install:** `npm i -g @ashx-j/lunr` (Node ≥ 22.19). Current published: **0.2.37**; v0.2.38 prepared.
- Workspace names stay `@earendil-works/pi-*`. `scripts/publish.mjs` rewrites **package.json and compiled JS/d.ts imports** to `@ashx-j/lunr{,-ai,-tui,-agent}`. Rewriting names only is not enough — `0.1.0` crashed with `Cannot find package '@earendil-works/pi-ai'`.
- CI: `.github/workflows/publish-npm.yml` on `v*` + `secrets.NPM_TOKEN`. Never publish `@earendil-works/*`.
- A release publishes seven packages: the four public packages plus three native CuaDriver payloads. `npm run publish:dry` packs all seven; `scripts/publish.mjs` accepts both npm 10 array and npm 12 keyed `npm pack --json` output.
- npm accepts a publish minutes before the CLI metadata and tarball resolve. Treat a tag as shipped only after every registry tarball matches its integrity and a fresh isolated install reports the new version.

## Build & run

- Offline builds: tsgo for tui, ai and agent, then `npm --prefix packages/coding-agent run build` (tsgo, assets and the Node bundle; bare tsgo leaves `dist/node-runtime` stale), then orchestrator. Root `npm run build` runs this offline sequence. CI does too and asserts `packages/ai` stays clean; live catalog generation is never part of PR validation.
- JSON catalog: `npm run sync:model-catalog` (needs network). Do not hook generate into root `npm run build`.
- Package builds are the production typecheck; the root check does not typecheck test fixtures. Coding-agent external dependencies are exact, and the standalone installer lock preserves workspace-local resolutions such as Zod 4. The relative-import check skips vendored `builtin-extensions/` and gitignored study trees.
- Tests: `bash test.sh --workspace=packages/coding-agent -- <test files> --maxWorkers=1` runs with disposable home/profile/cache/temp directories and an allowlisted environment without credentials. Plain package `vitest --run` uses the caller's profile.
- Pre-commit runs `scripts/check-lockfile-commit.mjs` then `npm run check` (Biome `--write`, pinned deps, relative imports, shrinkwrap, installer lock, publish-workflow policy, browser smoke), so it needs installed dependencies.
- First paint and first request: after the builds, `node scripts/check-interactive-first-paint.mjs [cli]` checks stalled and failed hydration plus first-turn subagent/MCP/LSP/fetch, and compares the full default tool payload with browser-on and browser-off baseline hashes. Async child questions: `node scripts/check-subagent-questions.mjs` (also `--idle`), logs under `.artifacts/`.
- From this repo, `npx lunr` runs the workspace bin (`packages/coding-agent/dist/cli.js`), not the installed `@ashx-j/lunr`; rebuild first. Worktrees can share one npm bin shim, so verify a worktree with `node packages/coding-agent/dist/cli.js`. Local npx is not a published smoke test.
- Published npm docs are `packages/coding-agent/{README.md,docs/**,examples/**,CHANGELOG.md}` (packed via `package.json` `files`). Repo-root README and untracked `lunr-docs/` are not what npmjs shows. `npm pack --dry-run --ignore-scripts --json --workspace=@earendil-works/pi-coding-agent` lists them.
- Release prep checks formatting without writing; normalize inherited formatting on the release branch first. Bump with `npm run version:patch`.

---

# Architecture

- **Features = baked-in extensions + bridges.** `builtin-extensions/` (factories registered in `builtin-extensions/index.ts`; hidden; vendored, 39 pi-subagents files and most other vendored files still `// @ts-nocheck`; biome-excluded). Light roster: simple-pi-memory, pi-tps, ashxj-tui, ashxj-spinners, ashxj-thinking, lunr-local-providers, lunr-todos, lunr-plan-tools, lunr-skill-creator. Deferred (interactive after paint; print/RPC/gateway before first turn): pi-ollama-cloud, narumiruna-pi-goal, lunr-cron, lunr-pr-watch, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, lunr-browser, pi-lsp-extension, pi-mcp-adapter, lunr-computer-use. Removed: lunr-settings-tools, lunr-behavior, context-mode, MattDevy + narumiruna collections.
- **Bridges:** `globalThis[Symbol.for("@lunr/...")]`. Never runtime-barrel-import `@earendil-works/pi-coding-agent` under `builtin-extensions/` — concrete modules only. `complete`/`streamSimple`/`getModel` from `@earendil-works/pi-ai/compat`.
- **Cron:** `core/cron` in TUI (live session) and gateway (fresh headless session). One `jobs.json` `~/.lunr/agent/cron/`. `runWithOrigin` ALS. Gateway fallback: `cronFallbackModels`. TUI cron uses the gateway's deliver allowlist.
- **Gateway:** Telegram long-poll + Discord (mention-gated, no GuildMembers intent). Authz fail-closed. `ADAPTER_FACTORIES`.
- **ACP:** `lunr --mode acp` adapts pi-acp with one native RPC worker per ACP session. Setup, limits and T3 settings: `packages/coding-agent/docs/acp.md`.
- **Footer:** ashxj-tui `setFooter` only. Toggles are render-time `CustomizeBridge` reads.
- **Permissions:** `yolo | auto | read-only` (`PERMISSION_MODES`, default yolo); Shift+Tab cycles that order and the TUI shows `read`. Read-only = `gateToolCall` + `readOnlyModeBlockReason` + `READ_ONLY_MODE_ADDENDUM`. Auto = yolo plus the AgentSession review step (`core/auto-review.ts`). "No questions" (`AUTONOMOUS_ADDENDUM`) is a per-session flag set by `/goal`, children and ACP Autonomous, not a mode. Fail-closed without handler. Bash is a heuristic, not an OS sandbox. 3+ children in one `tasks`/`chain.parallel` call, or that many same-turn SINGLE `subagent` calls, share one confirmation in yolo when `/settings` Confirm large subagent launches is on (default off); auto and autonomous sessions skip it. There is no `/swarm` command.
- **Rollback:** per-turn snapshots; `/rollback` forks and restores files. `/undo` and `/edit` stay in the same session via `navigateTree` (no fork).

# Renamed vs still "pi"

Renamed: bin `lunr`, `.lunr/`, `APP_NAME`. **Never write `~/.pi/`.** Still pi: `@earendil-works/pi-*` scopes, `PI_CODING_AGENT*` env, `getPiUserAgent`. pi-mcp-adapter still reads a legacy project `.pi/mcp.json` and treats `.pi` as a project-root marker on purpose.

# Notes

- Auto review runs in `AgentSession` after `gateToolCall`, not in `permissions.ts`, because it needs the model runtime, messages and session usage. Keep `needsAutoReview` derived from `readOnlyModeBlock` so new tools default to reviewed. It also reviews `web_fetch`/`fetch_content`, browser `navigate`/`tabs`, env-prefixed bash and hidden or outside paths (resolved with `resolveToCwd` + `canonicalizeTargetPath`).
- The reviewer never sees tool results. It clips long actions head-and-tail with a marker and lists `path`/`command`/`url` first. AGENTS.md and extension-sent user messages (tracked in a WeakSet by identity, lost after reload) are labelled as context that can't authorize anything. An aborted review returns early and never counts toward the ask-the-user limit. `autoReviewModel` is read from global settings only.
- ACP workers call `setAutoReviewEnabled(false)` and tie autonomy to ACP's `auto` (Autonomous), because the ACP client approves every tool itself. `-p` and gateway cron sessions in auto also set autonomy, preserving what a saved auto default meant before.
- To refresh the Windows/macOS first-request hashes from Linux, run the startup benchmark (`PI_STARTUP_BENCHMARK=1`) with an `--import` preload that returns `win32` for `process.platform` only when the stack includes `lunr-computer-use`. Check that it reproduces master's pinned hashes before trusting new ones.
- New top-level CLI subcommands must be added to `DEFERRED_COMMANDS` in `startup/launch-routing.ts`; otherwise a TTY launch paints the chat TUI first and its editor also consumes the command's input.
- Terminal notifications enable DECSET 1004 only while `terminal.attentionNotification` is on; TUI consumes `ESC [ I`/`ESC [ O` always. pty harnesses must write such reports in one write, or lunR reads a lone Escape plus typed text.
- Read `PI_OFFLINE` through `isOfflineModeEnabled()` (1/true/yes); a raw `!== undefined` check treated `0` as offline.
- To measure errors in `@ts-nocheck` files, rewrite each first line to `// @ts-nocheck-OFF`, run `tsgo --noEmit`, group errors by file, then restore. The directive only hides that file's diagnostics, so one run counts every file.
- Once the first-paint TUI owns the screen, any stdout/stderr write (runtime creation in `main.ts`, or later) moves the cursor outside TUI bookkeeping and leaves stale rows such as a second boot header. Route startup output through runtime diagnostics or managed components after history restoration. Do not fix it with repeated full-screen clears.
- First paint: keep the startup view's imports free of model/auth/resource services. The shared moon editor must retain its identity; forwarding callbacks to itself recurses. Snapshot its display values before session invalidation so /new and /resume cannot render a disposed context. First-frame timing waits for a completed synchronized-output content frame and uses time since process start. Read `packages/coding-agent/docs/interactive-startup.md` before startup, packaging or measurement changes.
- Cold start: interactive loads `lightBuiltinExtensions` only; deferred builtins attach after `ui.start()`, and `init()`/`getUserInput()` do not wait. Every `session.prompt`/`sendUserMessage` and `/new` waits for attach. `ModelRuntime.create()` and TUI init are cache-only (no GitHub/provider lists; local Ollama/LM Studio probes skip on `allowNetwork: false`). Initial interactive `resourceLoader.reload` skips missing npm/git auto-install. `PI_TIMING=1` prints timings after `init()` (time-to-type).
- Lazy extension lifecycle: session replacement invalidates pending work before new work binds. Await extension `session_shutdown` before gateway/cron disposal. MCP closes partial connections and shares one shutdown promise; LSP serializes shutdown and bind; `subagent_wait` waits only for pending launch registration.
- Node bundle: CLI and SDK exports must share chunks for class identity; preserve original module URLs and external native packages. Public `./rpc-entry` resolves through `dist/rpc.js`, which prefers the bundled runtime. Publish checks verify every exported target and scan staged `dist` after specifier rewriting.
- First-request fixtures strip inherited `PI_SUBAGENT_*`, `PI_SUBAGENTS_*` and `PI_INTERCOM_*` variables; inside a child the supervisor schema replaces intercom and the hash no longer measures the parent payload. Refresh both browser hashes after any agent-facing schema change. Capture inventories through the real CLI composition, not direct SDK tool descriptions.
- `LUNR_SYSTEM_INJECTION.md` is a local point-in-time effective-prompt snapshot, not an input. Regenerate it after changes to `system-prompt.ts`, active tools/extensions, `AGENTS.md`, skills, permission mode, goal state, memory, or `~/.lunr/agent/agents/AGENTS.md`.
- Tool schemas are the always-available discovery layer. Keep recovery/workflow instructions conditional in tool results where possible; reserve base-prompt rules for guidance required before the first call.
- Theme: `moon.json` is the builtin; `default.json` untracked/unwired. The chatbox uses `promptArrow`; legacy `promptMoon` is accepted but ignored. Body lines keep `│` side rails with the rounded top/bottom rules and thinking chip. Do not clobber `ChatboxEditor.borderColor`.
- Sticky chat + alt-screen has no native scrollback. While pinned, SGR 1000+1006 mouse tracking is on: wheel scrolls (Ctrl+wheel pages), left-drag does nothing, click expands/collapses a thinking run or tool card, Shift+drag is native selection, the last-column scrollbar drags. Do not use DECSET 1007 (collides with editor history).
- Pinned chat scroll reuses the last chat layout; do not re-layout or sync-render in `setChatScroll`. The overflow gutter is sticky. A scrolled-up view anchors matching rendered line sequences and falls back to the previous line position after width reflow.
- Selectors: keybinding layer (`tui.select.cancel`), never raw `\x1b` (Kitty CSI-u).
- Win32: Ctrl+V is the terminal's; image paste is `Alt+V`. lunR cannot see keys the host never sends, so VS Code must forward it with `sendSequence` `\u001b[118;3u` (leaked `ESC v` also works) or use `/paste-image`. Paste inserts `[image_n]` chips, not a temp path; do not expand them back to paths on submit. The first-paint editor releases its startup paste callback at activation.
- Smooth streaming is interactive-TUI only (`smooth-streaming.ts` + timer in `interactive-mode.ts`). Segment state lives on content-block objects, not the shallow-copied AssistantMessage, because providers append into the same block instances.
- Live thinking uses `reasoningDisplay`: auto is one line for `openai-codex`, four lines otherwise. One-line mode leaves its bottom unpadded because the working Loader already prepends a blank row; four-line tails do not pad. Both use the revealed prefix when smoothing; collapse needs provider completion and full reveal. Collapsed Codex snippets strip `**` at display only.
- Chatbox thinking chip prints the effective level including `xhigh`/`max`; `/thinking`, its completions and the `/off`…`/max` commands offer only `getSupportedThinkingLevels`. Ctrl+T cycles levels; `/thinking hide` hides blocks. Model and level changes print no status.
- Collapsed same-name tool rows are header-only and tree their details through `GroupedCallText`; wrap details after reserving the five-column gutter. Collapsed failures keep the tree and red state but defer bodies to expansion. Subagent compact widgets are the exception. `app.tools.expand` has no default key; `/tree` uses `ctrl+o`.
- Browser activity is presentation-only: backend call IDs, results, permissions and history stay unchanged. One live card follows browser calls until `agent_end`.
- Copyable `lunr-copy` text is parsed before the assistant-body trim. The payload is source text between the fences; never derive clipboard text from rendered lines. The box is clickable only after the closing fence is revealed. Keep `Component.handleClick` X optional.
- The wait card reads elapsed time from the leading `Waited`, `Wait timed out after` or `Wait aborted after` phrase; keep it in sync if those strings change.
- Extension widget layout sorts built-in keys explicitly. Keep `todos` directly before `subagent-async` with only the dim rule between.
- The subagent spinner setting changes the shared foreground/async glyph source live (default `braille`, choices from `unicode-animations`). Animation ticks stay unbounded and scale by each interval; a `% 10` counter freezes longer animations.
- Tab title: `process.title` + OSC 0 `lunr` in `cli-runtime.ts` before importing main; InteractiveMode then sets `lunr - [session -] cwd`. Do not call `ctx.ui.setTitle` from ashxj-spinners.
- `/undo` = same-session `navigateTree` rewind, no editor paste. `/edit` = that rewind then paste. Neither forks. `/rollback` forks.
- `/plan <task>` enters read-only if needed and sends `Create a plan for: <task>`; `/plan off` restores the previous mode. `present_plan` stays available in read-only.
- Plan footer uses a 60s usage cache. Preferred window is `/settings` Plan usage window (`5h` | `weekly`); missing 5h falls back to weekly. In Customize, Plan usage hides the segment while Plan bar hides only the █░ fill. The TPS counter is its own toggle; feature statuses only gate plan/goal.
- Skill tag is a mention (`$pdf-tools`; character `+`/`~`/`$`, default `$`). Do not expand it into a `<skill>` block; `/skill:name` force-loads. Open the picker only at a token start. With `~`, `~/` and `~\` stay paths.
- Settings menu descriptions name the feature, not every control. Keep choice-specific limits beside the choice. Factory defaults apply to missing keys; explicit saved values win and no migration rewrites them.
- Global behavior is optional `~/.lunr/agent/agents/AGENTS.md`: never auto-create it, add an in-app editor, or let model file tools modify it. A leftover `~/.lunr/agent/AGENTS.md` migrates there when the new path is empty. Per-model files are `~/.lunr/agent/agents/<model>/AGENTS.md` behind `/settings` Model instructions. Context breakdown labels it `Global AGENTS.md`. `behavior.md` is inert.
- Memory (`~/.lunr/simple-memory/memory.md`) is durable facts only; the toggle removes injection/tools but keeps the file. `core/protected-targets.ts` blocks direct file-tool writes to global instructions, memory, settings.json, `pr-watches/` and `install-features.json`.
- **Stop proposing boot-screen art.** Slim box only; ask first.
- Injected-prompt collapse is render-only (`[DEEP RESEARCH]` / goal marker).
- Catalog: see `packages/coding-agent/docs/model-catalog.md`. Humans edit the generator/adapters and regenerate JSON; never hand-edit `catalog/providers/*.json`. `models.json` is one minified line on purpose; cache-only create prefers `official-catalog-cache.json`.
- Official rows without `compat`/`thinkingLevelMap` take a baked-in template in `refreshOfficialCatalog`: same id first, then the provider's first model. The first-model fallback gave Haiku 4.5 adaptive thinking, which Anthropic rejects.
- `ModelRuntime.getModel` prefers the available-snapshot row, which carries credential-specific limits from `filterModels`; the plain catalog row is the fallback.
- `/model` lists stored credentials only (`auth.json`, subscriptions, `--api-key`); ambient env keys do not list models but still resolve for a selected model. Logout deletes that provider's `models-store` + user-models. `/refresh` calls `getAuth` before `GET /models` so expired OAuth refreshes; it rebinds the session model.
- xAI shares the official `grok` OAuth client, rotates refresh tokens and revokes the family on reuse. Adopt `~/.grok/auth.json` only when lunR is expired or after `invalid_grant`; write RFC3339 `expires_at`; never overwrite a newer Grok family or treat `modify(undefined)` as adopt. Remap to re-login only on `invalid_grant`/revoked refresh (`/usage` also on 401 billing), never on timeout or 403. Token refresh caps at 30s.
- xAI effort maps and Responses transport live in `generate-models.ts` / `xai-effort.ts` (grok-4.6+ `xhigh`; grok-4.5+ Responses via `parseXaiGrok4Minor`). `withXaiEffortMetadata` also runs in `mergeCatalogLayers`. Completions exceptions go in `XAI_RESPONSES_EXCLUDED_MODEL_IDS`; Completions compat must not leak onto Responses.
- OpenAI GPT effort floors live in `generate-models.ts` / `openai-effort.ts` as fallback; provider maps win. Codex generation and live discovery share `packages/ai/src/catalog/codex.ts`. Discovery is client-version-gated: an old version can return 200 without new models.
- OpenCode free models follow `zen/v1/models` ∩ models.dev, not models.dev `deprecated` status. Do not add `opencode` to `LIVE_LIST_PROVIDER_IDS`.
- Extension aliases match prefixes. Keep the AI catalog directory ahead of its root compatibility-file alias.
- Claude subscriptions: `/login anthropic` downloads pinned Claude Code (`CLAUDE_CODE_VERSION` 2.1.263) into `~/.lunr/agent/claude-code/<version>/` after confirmation, verifies per-platform integrity and reuses Claude Code's own sign-in. Setup reads the picker (`initialize`), then `set_model` + `get_context_usage` per route, and saves a version 3 record `models: [{ id, route, contextWindow }]` in picker order. It skips variants whose description mentions usage credits (no structured billing field). Version 1 and 2 records need `/login anthropic`.
- Subscription turns use an injected SDK `fetch`: Claude Code sends the request straight to Anthropic; lunR rebuilds SSE from `--include-partial-messages` `stream_event` lines, stops Claude Code at `message_stop`, and rebuilds HTTP errors from `api_error_status`. `terminal_reason: api_error` without status is a retryable network error. Local failures travel as SSE `error` because the SDK hides `fetch` exceptions. The loopback serves only the MCP tool inventory. The bridge stamps the request model on every assistant frame or Claude Code drops signed thinking.
- Never set `ANTHROPIC_BASE_URL` for a real subscription turn, read Claude Code credentials, restore pi's Claude Code OAuth route, or fall back to direct OAuth HTTP. Setup discovery points Claude Code at a TCP tripwire that passes only the credential-free `HEAD /api/hello` warm-up (sent unless a proxy, socket or client cert is set). Bumping `CLAUDE_CODE_VERSION` needs all eight platform integrity values and a fresh live qualification.
- Offline real-binary Claude Code checks need a disposable `HOME` with fake `.claude/.credentials.json`, a loopback upstream, and `HTTPS_PROXY` at a dead port with `NO_PROXY=127.0.0.1`. Login test fakes must answer `--version` with `CLAUDE_CODE_VERSION`.
- The AI package loads the Claude Code bridge through a computed import specifier; a literal path breaks the browser smoke check.
- ACP: no-approval tools are core `READ_ONLY_TOOLS` plus `todo`; add side-effect-free tools there. Tool calls are announced at start and end only. Modes may change mid-turn; model and reasoning changes are idle-only and stay session-local. `clientScopedModelsOnly` narrows RPC `get_available_models`; workers read it at startup.
- ACP cannot retract a form or approval; an expired request keeps its turn open until the host dismisses it. Startup dialogs return cancellation defaults. ACP sessions disable delegation guidance, browser, cron, goals and scheduled subagents (jobs can outlive a client turn) but keep MCP and explicit native children; child delegation strips temporary host MCP credentials. Child notices use content-based activity IDs.
- T3 caches each ACP agent's model list until provider refresh or restart; logging out of lunR providers does not shrink it until then.
- Advertised children always start fresh; `fork-context.ts` stays only so upstream sync compiles, so do not advertise `context: fork`. Children are `task` + `description` + exactly one of `tier` or `model`, plus optional `permissions`. Use tiers unless the user names a model; `thinking` belongs to explicit models. Resume preserves selection from the recovery descriptor.
- Omitted `async` launches in the background; `async:false`, `clarify:true` and correlated internal bridges stay foreground. Slash and prompt workflows accept `--foreground`. Resolve launch mode in `runs/background/top-level-async.ts` after `resolveSubagentRequestParams` normalizes mixed payloads.
- Async parallel converts `tasks` into `chain.parallel`; both direct and clarify-to-background adapters must forward `model` and `thinking` with `tier`.
- Child `permissions: "full"` is not parent-equivalent: coding tools (read/search/shell/edit/write/web/LSP/MCP), no cron, memory, goals, present_plan or nested `subagent` unless fanout-authorized. The parent snapshots `PI_SUBAGENT_CHILD_PERMISSION` and, in auto, its reviewer in `PI_SUBAGENT_CHILD_AUTO_REVIEW`; full runs in auto when that is set and yolo otherwise, read-only as read-only, and every child is autonomous. A read-only parent rejects full launches. Non-child `lunr -p` stays fail-closed.
- Compact rows are `glyph description · tier|model · tokens · time`, with `failed`/`paused`/`stopped`/`detached` appended. One line for foreground and async; no thinking, tool counts or role names. Badges use `modelSelection` captured at spawn, not `result.model`. A visible single result's header does not repeat the description. Do not print `⚠ Subagent needs attention` cards.
- `description` is presentation only. Route intercom/resume/steer by private `childId`; fanout suffixes it per item and appended async steps need a fresh namespace.
- Subagent schema prune must keep properties named `description`. Drop control `action` when `task`/`tasks`/`chain` are present (except `schedule`/`append-step`/`resume`/`steer`); if a non-empty `task` remains, drop dummy `tasks`/`chain`.
- Default parallel launch is unlimited; honor explicit `concurrency`.
- Async recovery descriptors store resolved acceptance. Read them with the persisted validator, not launch-input `validateAcceptanceInput`, and do not re-infer from the revival wrapper. Pass the current follow-up separately as `completionTask`.
- Supervisor ownership uses `PI_SUBAGENT_SUPERVISOR_SESSION_ID`; routing keeps `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`. Compare each exactly. `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` skips broker `contact_supervisor` and broker spawn; the broker must not replace the native schema.
- Only answered supervisor questions wake the parent. Blocking `need_decision`/`interview_request` is `needs_attention` for `subagent_wait`. The owner notifier delivers terminal results once; relays keep ACK/retry but skip local delivery when `ownerNotificationSessionId` matches. Parent cards show the `handoff` kind as `progress`.
- Async Escape: a second press within 500ms stops session-owned runs through a lazy session-keyed bridge. Stop requests differ from confirmed termination; stopped completions do not wake the parent. Delivery retries reuse the request id and keep the file after three failures.
- Interactive `subagent_wait` interruption is run-scoped: capture the owning signal at wait start, release only those waits, and wait for `agent_settled` before the fresh prompt. Do not infer execution from TUI cards or abort siblings.
- Subagent communication is a global setting snapshotted per run; turning it off blocks new parent questions and steering at once while pending replies finish.
- Child event frames apply only to print JSON in a child; the parent decodes them before persisting. Keep the per-line guard and total-event cap. `cacheRead` is separate from the compact row count.
- A chain step gets text through `{previous}`; notify only producers with a later step.
- Intercom broker spawn prefers sibling `broker.js` with node. On Windows `cmd.exe` cannot redirect into `broker.stderr.log` while the parent holds it; the launcher waits for an exit code only during startup. Fixtures must stop their broker before removing its profile.
- Default-off watchdog startup must never fingerprint the repo; establish the repo-edit baseline only at `before_agent_start`.
- Read-only blocks unclassified extension tools, including direct MCP tools; the `mcp` proxy allows status, search, describe and ui-messages. Saved `manual`/`plan` values read as yolo/read-only without rewriting. Gateway switches to a saved writable mode pause in read-only until confirmed. Read-only does not revoke running full-access children.
- Gateway: paired and allowlisted users share one authorization. `ConversationBinding.owner` identifies the requester, not a tier; keep requester and fresh access checks on delayed approvals and deliveries. Legacy `owners` entries are ordinary grants. Busy-session `/stop` `/new` bypass the session guard; Telegram length = `string.length` (UTF-16).
- Gateway outbox: result entries keep their source across `/new`; prompts/notices use an epoch. Failed batches stay on disk with `failed: true`. A crash between send and on-disk ack can duplicate the last chunk.
- Gateway fixtures must isolate `PI_CODING_AGENT_DIR` and save configuration because callbacks recheck persisted authorization. The compiled local gateway check uses an OS-temp fixture; never commit `.artifacts/`.
- Computer use: read `packages/coding-agent/docs/computer-use.md` before changing capture/input, history retention, native ownership or distribution. `scripts/computer-use-release.json` owns the pin; regenerate `release.generated.ts` after changing it. CuaDriver 0.28.1 is production-approved; a new runtime needs approval and a new CLI version.
- Computer results carry `details.computer` and use the scoped `tool_result` hook for the error flag; a thrown text error discards recovery images. Dispatch tracking is per call; a rejected token says nothing about earlier input. Image-only means no accessibility tree in observations; map image coordinates through crop/resize exactly once.
- Windows CuaDriver 0.28.1: XAML `hotkey` ignores `delivery_mode`, so foreground modifier shortcuts without x/y go through `press_key` with modifiers. `move_cursor` moves the real pointer only in desktop scope. Discovery queries match only `name`, `app_name` and `title` and never select a target.
- Computer install/staging tests use inert payloads with test-only checksums; they validate packaging, not runtime acceptance.
- PR watch: see `packages/coding-agent/docs/pr-watch.md`. Watches run only in the owning session; deadlines keep running while closed, expiry wins before any read, and only a newly observed head resets the window. Admission uses promise-returning `ctx.sendMessage`; failed admission retries on the watch timer.
- PR-watch reservations consume events only after a persisted notification or tool-result receipt. A same-turn wait removes only its own queued custom message (matched by type and details object) and transfers the reservation. Conditional 304 responses can change pagination Link metadata.
- Usage records live in session custom entries outside model context. Request IDs survive receipt replay; forks carry context but no new spend. Unknown usage and prices stay distinct from measured zero.
- `THIRD_PARTY_NOTICES` must stay in the public files allowlist; staging copies both notices. Notice tests compare complete source bytes, not author names.
- Resource-loader extension fixtures need current package builds because jiti resolves compiled aliases. Source CLI fixtures load tsx; a source-test pass does not qualify the compiled CLI. Keep legacy migration inputs and credential sentinels under `.pi`.
- Rollback fixtures keep their failure-injection tests and one disposable-home strategy. Memory restoration follows `dirname(getAgentDir())/simple-memory`.
- `lunr update` is npm global `@ashx-j/lunr` only. Workspace `PACKAGE_NAME !== NPM_CLI_PACKAGE` skips the nag and refuses to self-update.
- Shipped docs: author for `@ashx-j/lunr` / `lunr` / `~/.lunr/`; keep ExtensionAPI `pi`, package.json `"pi"` and `PI_*` names.
- Process registry: direct children only; `nohup &` grandchildren untracked.
- vite/oxc: `import type { A, B }` not `import type { A, type B }`.
- `// lunr:` = upstream edit markers. Hot sync files: `ashxj-tui.ts`, `interactive-mode.ts`, `agent-session.ts`, `bash.ts`, `settings-manager.ts`, `main.ts`, `builtin-extensions/*`.

# Decisions (keep; why in one line)

- 2026-10-18: auto is reviewed and "no questions" is a separate session flag, so goals and subagents keep working unattended under yolo without paying for reviews.
- 2026-10-18: default reviewers come only from providers whose own agents ship one (Claude Code, Codex, Grok Build, Qwen Code); other providers must pick a model, because choosing a safety reviewer is the user's call.
- 2026-10-18: remove `/share` and the subagent `share` option instead of hosting a viewer, because both sent sessions to pi's site; keep accepting the old descriptor field so saved runs resume.
- 2026-10-18: read a saved `shadow-git` rollback capture as `copies`, because that is what the menu promised and it deletes fewer files than the hybrid behavior it had.
- 2026-10-18: gate notices on terminal focus reports, not run length, so watched runs stay quiet and abandoned short runs still ping.
- 2026-10-18: enable type checking on pi-subagents files that already pass before fixing errors, so new mistakes there fail the build without touching vendored behavior.
- 2026-10-17: derive Claude subscription routes and windows from Claude Code's picker and `get_context_usage`, skipping usage-credit variants, because a hardcoded route table goes stale and had routed Opus 5 to credit billing.
- 2026-10-17: let Claude Code send subscription requests straight to Anthropic and read its `stream_event` output, because Anthropic's terms bar developers from intermediating Claude.ai session tokens while allowing sign-in to unmodified Claude Code.
- 2026-10-17: after `/login`, fall back to the provider's first offered model in Claude Code picker order, so plans without the hardcoded default still get Claude Code's default.
- 2026-10-17: narrow app model lists in RPC `get_available_models` behind an opt-in setting so ACP and the RPC provider share one rule and `/model` stays unchanged.
- 2026-10-16: let ACP clients change modes mid-turn and re-check read-only on open approvals, because the spec allows it and gates read the mode per call.
- 2026-10-15: keep Claude subscriptions on a lunR-managed pinned Claude Code because Anthropic's terms forbid third-party Claude.ai login and impersonation, and setup then needs no Python or matching local install.
- 2026-10-15: inject Claude Code as the Anthropic SDK `fetch` so subscription turns reuse the Messages request builder and stream parser.
- 2026-10-11: adapt pi-acp around one native RPC worker per ACP session so T3 reuses lunR's tools and journals without changing saved defaults; apply ACP settings as in-memory overrides.
- 2026-10-11: send ACP status and child notices as activity because T3 concatenates assistant chunks; label models by name and add the provider only on duplicates.
- 2026-10-11: ship pi attribution in `THIRD_PARTY_NOTICES` so the main license identifies lunR while distributions keep the upstream notice.
- 2026-10-11: change fallback defaults without a migration so explicit saved choices stay authoritative.
- 2026-10-06: share receipt-backed delivery between PR waits and async notifications so interruption and restart cannot lose or duplicate feedback.
- 2026-10-06: keep PR-watch duration and cancellation under user control with head-only resets, so agents cannot silently extend monitoring; leave readiness judgments to the agent.
- 2026-10-04: count durable request identities across conversation and auxiliary calls, and prefer provider-reported spend, so navigation and replay cannot erase or duplicate usage.
- 2026-10-04: integrate reviewed PRs through merge ancestry in one integration or release PR and require fresh green CI, so overlapping files resolve once and baseline failures do not ship.
- 2026-10-03: isolate test profiles with an allowlisted environment instead of moving saved credentials.
- 2026-09-27: production approval of the pinned CuaDriver needs explicit owner confirmation, separate from byte integrity and runtime acceptance.
- 2026-09-26: keep uncertain native computer outcomes with one recovery image, because an error after delivered input must not invite blind replay; accept effects only from fresh post-action images.
- 2026-09-13: bound screenshot payloads and keep provider history until targeted retention can be measured against prompt-cache disruption.
- 2026-09-26: default substantive delegation to the standard tier and require a specific reasoning difficulty for heavy, because broad labels encouraged over-selection.
- 2026-09-26: use one gateway authorization check for messages and commands so pairing grants usable access without a second owner approval.
- 2026-09-26: reuse the gateway outbox for final answers and follow-ups and keep bounded failed batches instead of retrying forever or dropping text.
- 2026-09-25: frame oversized child JSON events instead of raising the stdout line limit, so image results survive while transport stays bounded.
- 2026-09-24: replace manual and plan with yolo, auto and read-only, and fail closed on unclassified tools in read-only, because proxy and direct MCP calls can write.
- 2026-09-24: keep parent-child messaging and autonomous delegation as independent default-on switches, because direct-work mode should still allow requested children.
- 2026-09-21: put fresh-versus-resume and gateway management in the default prompt because both must be right before the first tool call.
- 2026-09-21: treat Enter during `subagent_wait` as a run-scoped graceful handoff so background work survives.
- 2026-09-13: keep intercom and its relay, fixing Windows stderr ownership instead of replacing the communication system.
- 2026-09-12: gate question wakeups on answered state so cancellation cannot undo a double-Escape stop.
- 2026-09-12: children choose exactly one of tier or model so user-named models work without tier mode.
- 2026-09-12: remove agent settings tools and `watchdog.configure` so settings stay in `/settings`.
- 2026-09-08: Codex uses each route's `context_window` as its compaction budget and checks it between tool turns; `max_context_window` never becomes the default.
- 2026-09-08: skip automatic compile-cache for the Node bundle because reuse increased measured startup latency.
- 2026-09-05: paint the production TUI before runtime imports and bind the existing editor in place, so startup does not wait on hydration or lose drafts.
- 2026-09-05: CI and the root build use offline package builds so validation cannot drift the generated catalog.
- 2026-09-05: pin coding-agent external dependencies and map workspace-local rows into the installer lock so published installs resolve reviewed versions.
- 2026-09-05: use package builds for production type safety and Vitest for tests; the root no-emit pass mixed incompatible fixture types.
- 2026-08-30: persist `modelSelection` at spawn because resolved `spec.model` cannot distinguish tier routing from an explicit model.
- 2026-08-29: prompt-driven subagents replace named types with task+description+full|read-only; private `childId` routes because display labels misaddress children.
- 2026-08-29: separate user-owned global instructions from agent-managed memory facts; the memory toggle hides injection/tools without deleting data.
- 2026-08-29: Fast mode persists only for `openai-codex`; paid `openai` API models never activate it.
- 2026-08-29: `/usage` renders all stored adapter plans; the footer stays current-provider-only.
- 2026-08-29: remove `/research`; generic subagents and web tools cover research.
- 2026-08-28: watchdog repo-edit fingerprints are lazy and enable-gated so a default-off reviewer cannot block prompt readiness.
- 2026-08-24: same-turn SINGLE `subagent` calls count toward the large-launch gate; sequential work stays `chain`.
- 2026-08-23: grok-4.5+ uses Responses via `parseXaiGrok4Minor >= 5`, not a frozen id; the overlay replaces Completions compat.
- 2026-08-20: stamp Grok 4.6+ xhigh in `mergeCatalogLayers` and rebind the session model after `/refresh`, because the session holds a stale Model object.
- 2026-08-18: cache smooth-streaming grapheme ends per content block, because a message WeakMap went stale when providers did `block.text += delta`.
- 2026-08-17: time-to-type = `ui.start()` + light rebind; gate prompt and `/new`, not the editor, because awaiting deferred attach and auto-installs hung startup.
- 2026-08-16: first paint is cache-only because live `refresh()`, localhost probes and uncapped OAuth hung boot after idle.
- 2026-08-16: model-tiers toggle uses `pi.registerTool`, not `pi.runtime` (not on ExtensionAPI); refresher errors are not fatal.
- 2026-08-16: public install is `npm i -g @ashx-j/lunr` with publish-time rewrite of package.json **and** dist imports. Do not publish `@earendil-works/*`.
- 2026-08-14: sticky chatbox in `packages/tui`; xAI `/usage` = weekly SuperGrok pool; usage bars use 70/90.
- 2026-08-13: todos = extension, full-replace; plan approval = `present_plan`; custom provider writes models.json then login.
- 2026-08-08: `thinkingCollapse` layered on `hideThinkingBlock`; `/exit` = `/quit`.
- 2026-08-06: subscriptions sibling file; auth.json = active key; `autoManageSubscriptions` is manual switch only.
- 2026-08-03: do not add boot art. `qwen-cloud` ≠ token-plan. `/refresh` is the only refresh command.
- 2026-07-28: cron in TUI + daemon; Discord discord.js; Telegram long-poll; authz fail-closed.
- 2026-07-26: extension-absorption rolled back — baked-in extensions + bridges only. No “done” without live `npx lunr` + one message.
- 2026-07-22 / 08-15: no pi.dev catalog. `/refresh` = local `/models` + our GitHub `catalog/`.
- 2026-07-18: `.lunr/` split; keep `pi-*` scopes + `PI_CODING_AGENT_*`.

# Deferred

- Gateway cold first slash after daemon start can hang minutes; local scripted-provider first-use flow passes but does not establish a cold-start latency bound.
- Live verify: Ollama/LM Studio, zai Bearer, multi-key rotation, catalog `/refresh` + `/model` after stability merge.
- Claude subscriptions: live runs used one signed-in account; macOS and ARM remain unqualified.
- Computer use: held modifier/button release, Mac/ARM hardware, provider-driven use, and live Windows hover/taskbar recovery remain unverified. Smooth cursor animation needs a scope decision.
- Scope rename; `PI_CODING_AGENT*` rename.
- Rollback: shadow-git capture (option removed until built), gateway rollback (B7), orphan GC, symlink escape. Orchestrator timeouts from closed PR #41 remain unshipped.
- Cron: script/`no_agent` jobs; more gateway platforms; process-tree for `nohup` grandchildren.
