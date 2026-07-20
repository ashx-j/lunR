# lunR UX/Providers plan — progress log

## 2026-07-19 — Phase 1: Remove MattDevy + narumiruna extension collections (keep pi-goal)

### What changed
- Deleted 18 of 19 collection directories under `packages/coding-agent/src/builtin-extensions/`:
  - MattDevy (6): pi-blueprint, pi-code-review, pi-compass, pi-continuous-learning, pi-red-green, pi-simplify
  - narumiruna (12): pi-btw, pi-caffeinate, pi-chrome-devtools, pi-codex-accounts, pi-codex-usage, pi-firecrawl, pi-github-pr, pi-google-genai, pi-langfuse, pi-plan-mode, pi-retry, pi-sync
- **Kept** `narumiruna-pi-goal` (plan 2's /goal indicator) and all non-collection extensions untouched.
- `packages/coding-agent/src/builtin-extensions/index.ts`: removed the 18 imports and their `ext(...)` registrations; `narumirunaGoal` import/registration kept.
- `packages/coding-agent/package.json`: removed the 5 langfuse-only deps (`@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node`). All other bake-in deps stay. `npm install` run from repo root to sync `package-lock.json`.
- `copy-assets` checked: it only references `context-mode` and `pi-subagents` asset paths — nothing inside deleted dirs, no changes needed.
- Reference sweep: greps for `mattdevy|narumiruna|langfuse|opentelemetry` across `packages/coding-agent/src` and `test` now hit only the kept pi-goal import/registration in `index.ts`. `main.ts` and the startup Extensions filter (interactive-mode.ts:1476) are name-agnostic — no hardcoded lists to fix.
- `extension-repos/` reference clones NOT deleted (kept as study material; narumiruna clone needed for Phase 12 plan-mode reference).

### Side effects
- Commands gone: `/codex-status`, `/codex-login`, `/codex-account`, `/codex-logout`, `/btw`, `/plan` (until Phase 12 re-adds plan mode natively), plus the deleted extensions' other commands (code-review, simplify, compass, etc.).
- Caffeinate acquire/release notification noise gone by deletion.
- The langfuse `getAgentDir()` fix and the MattDevy hardcoded `~/.pi` known-issues are moot (deleted code).

### Verification
- Build: `packages/agent` → `packages/coding-agent` → `packages/orchestrator` all compile clean (exit 0). Did not rebuild `tui`/`ai` — existing dist used, avoiding the known ai live-catalog drift issue.
- `npx biome check packages/` — clean (800 files).
- Tests: coding-agent vitest — Test Files 88 failed | 85 passed | 2 skipped (175); Tests 56 failed | 982 passed | 21 skipped (1059). Compare baseline (58 failed | 980 passed | 21 skipped; 89 load-failures): actually 2 fewer failures, all remaining are the known pre-existing categories (load-failure circular import, symlink EPERM, path separators, network-dependent, Windows quirks). No NEW failures.
- `npx lunr --version` — 0.80.10. coding-agent dist clean-rebuilt (`npm run clean && npm run build`) so stale compiled output from deleted extensions is gone; dist/builtin-extensions/ now contains only kept extensions.

### Deviations from plan
- None in file scope. Interactive runtime verification (`/goal` end-to-end, `/` autocomplete, caffeinate-free startup) not performed in this session — static/build-level verification only.

## 2026-07-19 — Phase 2: Boot screen (art, skills counter, drop hints + resource listing)

### What changed
- `packages/coding-agent/src/modes/interactive/components/boot-ascii.ts`: verified byte-in-sync with repo-root `boot-ascii.md` (11 lines each, mechanical comparison via node script). The user's updated md was already committed in `87b0a98` with matching generated art — no regeneration needed.
- `packages/coding-agent/src/modes/interactive/components/boot-screen.ts`: deleted the `footerLines` mechanism (constructor param, field, render push) — unused once hints were removed. Constructor is now `(header, rows)`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (~:780): removed `compactInstructions` + `onboarding` lines and the `hint` helper closure from the boot block; `BootScreenComponent` now constructed without footerLines. Added skills row: `getSkills().skills.length` pushed as `{ label: "skills", value: String(count) }` only when count > 0. Import line dropped now-unused `keyHint`/`rawKeyHint` (`keyText` still used at :1994 area).
- `interactive-mode.ts` `showLoadedResources()` (~:1438): `showListing` changed from `force || verbose || !quietStartup` to `force || verbose` — the [Context]/[Skills]/[Prompts]/[Extensions]/[Themes] listing no longer renders at startup/reload by default; `--verbose` brings it back. Diagnostics ([Skill conflicts], [Extension issues], etc.) still surface via `showDiagnosticsWhenQuiet`. Function kept (both call sites pass `force: false`; gating behind `--verbose` per plan).
- `packages/coding-agent/test/interactive-mode-status.test.ts`: 15 listing tests now pass `verbose: true`; "shows a compact resource listing by default" split into "does not show the resource listing by default" (empty container) + "shows a compact resource listing in verbose mode".

### Verification
- Build: agent → coding-agent → orchestrator compile clean (exit 0); `npx biome check packages/` clean (800 files).
- Full coding-agent suite: Test Files 88 failed | 85 passed | 2 skipped (175); Tests 56 failed | 982 passed | 21 skipped (1059) — byte-identical to the Phase 1 baseline, no NEW failures. Note: `interactive-mode-status.test.ts` is one of the 88 pre-existing load-failures (ashxj-tui circular import), so the updated tests don't execute under vitest; verified equivalently via a tsx harness instead.
- tsx smoke harness (import order `main.ts` first to dodge the circular import): BootScreenComponent renders moon art + rows (model/directory/session/config/theme/skills: N) at width 100, details-only at width 40, no hint/onboarding text; `showLoadedResources` renders nothing by default and the [Skills] section with `verbose: true`. All assertions passed.
- Skills availability: `createAgentSessionServices` awaits `resourceLoader.reload()` (agent-session-services.ts:152) at session creation, before `interactiveMode.init()` (main.ts:834) — the boot-row count is real data, not an empty loader.

### Deviations from plan
- Art regeneration was a no-op (md and generated ts already in sync from `87b0a98`); confirmed mechanically rather than blindly rewriting.
- Interactive `npx lunr` TUI verification not performed (no pty in this session) — static render harness only.

## 2026-07-19 — Phase 3: Subagent extension-path fix + simplified subagent view

### What changed
- **3a (fix):** pi-subagents built child-process extension/script paths from `import.meta.url` with hardcoded `.ts` filenames; the bake-in compiles to `dist/` `.js` only, so every subagent run died with "Extension path does not exist". Fixed all three sites with an existence check — use the `.ts` when present (upstream dev), else the compiled `.js` sibling (`// lunr:` marked):
  - `packages/coding-agent/src/builtin-extensions/pi-subagents/src/runs/shared/pi-args.ts` (~:17-27): new `resolveRuntimeScriptPath(basePathWithoutExt)` helper (fs.existsSync `.ts` → else `.js`); `PROMPT_RUNTIME_EXTENSION_PATH` and `FANOUT_CHILD_EXTENSION_PATH` now resolve through it.
  - `packages/coding-agent/src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts` (~:400): `runnerTsPath` + existsSync ternary falls back to `subagent-runner.js` (still spawned via jiti, which loads plain `.js` fine).
- **3b (simplified collapsed view):** `packages/coding-agent/src/builtin-extensions/pi-subagents/src/tui/render.ts` (`// lunr:` marked):
  - New `taskSummaryText(task, 60)` helper: first line of `r.task`, whitespace collapsed, ellipsis at ~60 chars.
  - `renderSingleCompact`: row is now `<glyph> <task summary> · <agent> · <stats via formatProgressStats>` (model badge and turns stat dropped per the new format). Running rows keep the dim `⎿` activity + live-status lines. Deleted: `liveDetailHintText()` line, both `output: artifactPaths` lines, the `full output:` truncation-artifact line. `session:` line and output preview kept (not in the deletion list).
  - `renderMultiCompact` per-result rows: same new format (`glyph · task summary · agent · stats`), `Step N`/`Agent N/M` row label dropped from result rows (pending rows keep it — no task available yet). Deleted: `liveDetailHintText()` line, `extractOutputTarget` `output:` line, per-row `artifactPaths` `output:` line, and the trailing `artifacts:` footer line. Multi header row unchanged.
  - Expanded views and the async-jobs widget untouched (still use `liveDetailHintText`/`extractOutputTarget`/`modelThinkingBadge` — all helpers remain referenced).

### Verification
- Build: coding-agent rebuild clean (exit 0); orchestrator rebuild clean (exit 0). Did not touch agent/ai/tui dists.
- dist contains the fix: `resolveRuntimeScriptPath` in `dist/.../pi-args.js`, `runnerTsPath` ternary in `dist/.../async-execution.js`, `taskSummaryText` in `dist/.../render.js`. All three fallback targets exist in dist (`subagent-prompt-runtime.js`, `extension/fanout-child.js`, `background/subagent-runner.js`) — verified via a node existence-check script replicating the fallback logic against dist paths.
- `npx biome check packages/` — clean (800 files).
- Tests: coding-agent vitest — Test Files 88 failed | 85 passed | 2 skipped (175); Tests 56 failed | 982 passed | 21 skipped (1059). Byte-identical to the Phase 1/2 baseline — no NEW failures.
- Render smoke harness (node against dist, importing `dist/main.js` first to dodge the known ashxj-tui circular import): single-done, single-running, and multi (done/failed) collapsed renders all show `glyph task-summary · agent · N tool uses · tokens · runtime`, keep the `⎿` activity/error lines, and contain no "Press … for live detail" hint and no output/artifact paths. All assertions passed; harness deleted after use.

### Deviations from plan
- Multi-mode result rows drop the `Step N`/`Agent N/M` label entirely (plan's row format doesn't include it); chain ordering is still conveyed by row order. Pending rows keep the label since they have no task text.
- Live runtime verification of an actual subagent run (foreground/async/fanout under `npx lunr`) NOT performed — requires a live model + pty. Path-existence verified statically against dist instead. **Pending: one interactive `/subagents` smoke run.**

## 2026-07-19 — Phase 4: Dot-only status coloring + message dots

### What changed
- `packages/coding-agent/src/core/tools/render-utils.ts`: new `toolStatusDot(state, theme)` ("pending"→muted, "success"→success/green, "error"→error/red, glyph `●`) and `toolStatusDotFromContext({isPartial,isError}, theme)` helper (structural typing, no import of extensions/types).
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` (plan said `core/tools/tool-execution.ts` — the file actually lives here): new `getStatusDot()` (isPartial→pending, result.isError→error, else success); dot prepended in `createCallFallback()` and `formatToolExecution()`.
- Built-in renderers, dot prepended to the renderCall title line via `toolStatusDotFromContext(context, theme)`: `core/tools/bash.ts`, `read.ts` (both normal and compact-classification titles), `write.ts`, `grep.ts`, `find.ts`, `ls.ts`. `edit.ts` (renderShell "self"): `buildEditCallComponent` takes a new `dotState` param, computed at both call sites (renderCall + renderResult rebuild). renderResult bodies render no title line, so no dot there.
- `modes/interactive/components/user-message.ts` `rebuild()`: markdown source now prefixed with a plain `● `.
- `modes/interactive/components/assistant-message.ts` `updateContent()`: first non-empty TEXT block (never thinking blocks) prefixed with plain `● ` via an `isFirstTextBlock` flag.
- Tests updated (intended-change expectations, minimal): `test/assistant-message.test.ts` — the two padding tests now expect the dot (`" ● hello"` padded / `"● hello"` unpadded; `" ● hello"` for the assistant padding case).

### User/assistant dot approach (plan asked to record the choice)
Plain, uncolored `● ` prefix in the markdown source for BOTH components — NOT `theme.fg("brightWhite", "● ")` (that token doesn't exist; closest is `accent` = brightWhite in moon), and NOT a separate leading Text line. Reason: Markdown applies its per-token text color around whole runs, and `theme.fg()` resets with `\x1b[39m` without reopening the outer color — an embedded colored dot would silently strip userMessageText from the rest of the paragraph. The plain prefix renders the dot in the message's own text color: userMessageText (white in moon) for user messages, terminal default (white on black) for assistant messages. Verified in the render harness: colors intact, dot on first line, thinking blocks undotted. Known edge case: a message whose first line is a markdown construct (`# heading`, `- list`) now renders that first line as literal text after the dot.

### Verification
- Build: agent → coding-agent → orchestrator compile clean (exit 0). `ai` not rebuilt (live-catalog drift issue avoided).
- `npx biome check packages/` — clean (800 files; one import-sort auto-fix in edit.ts).
- Render smoke harness (tsx, deleted after use): user message `● hello…` white-on-bg; assistant first text block dotted, thinking + later blocks not; bash pending = gray dot; read success = green dot; read error = red dot; generic fallback (unknown tool) = green dot. ANSI inspected raw — no color bleed after dots.
- Tests: coding-agent vitest — Test Files 88 failed | 85 passed | 2 skipped (175); Tests 56 failed | 982 passed | 21 skipped (1059). Byte-identical to the Phase 1-3 baseline — no NEW failures. Targeted rerun of the 4 touched render test files (assistant-message, user-message, tool-execution-component, edit-tool-no-full-redraw): 4 files / 33 tests, all pass.

### Deviations from plan
- `tool-execution.ts` path correction (modes/interactive/components/, not core/tools/).
- `toolStatusDot` takes `theme` as a param (matches render-utils.ts conventions) instead of closing over a module theme.
- Message dots are plain-text prefixes, not `theme.fg("brightWhite", …)` — see approach note above.
- Live `npx lunr` TUI verification not performed (no pty) — render harness only.

## 2026-07-19 — Phase 5: Session management (auto-name, /title, /sessions, retention)

### What changed
- `/title <name>` — alias sharing `handleNameCommand` (regex now `/^\/(?:name|title)\s*/`); dispatch merged into the `/name` branch; `BUILTIN_SLASH_COMMANDS` entry added. `/name` unchanged.
- Auto-name — `InteractiveMode.autoNameTriggered` one-shot guard; `maybeAutoNameSession()` called at `agent_end` (after the swarm/research status blocks). Fires only when the session is unnamed AND has exactly one user message (fresh sessions only; resumed unnamed sessions with history are skipped and never retried). `generateSessionTitle()` picks light tier model via `resolveModelReference(settingsManager.getTierModel("light"))` when `getModelTiersEnabled()`, else `this.session.model`; one-shot `session.modelRuntime.complete(model, { messages: [...] })` with a ≤6-word title prompt (first user text truncated to 2000 chars); title text collapsed, quotes/trailing punctuation stripped; re-checks `getSessionName()` after the await so a mid-flight user `/name` wins; then `session.setSessionName(title)`. Fire-and-forget; errors swallowed to the debug log.
- `/sessions` — merged into the `/resume` dispatch branch, opens the existing `SessionSelectorComponent` via `showSessionSelector()`; selection resumes through `handleResumeSession` → `runtimeHost.switchSession` (the same in-process path `/resume` uses).
- Retention — new `core/session-retention.ts`: `pruneOldSessions(root, days, { excludeFile, now })` deletes `.jsonl` older than `days` at depth 0 (flat custom `--session-dir` layout) and depth 1 (`--<cwd>--/` project layout); per-file errors swallowed; `excludeFile` never deleted (case-insensitive compare on win32); `days <= 0` no-op. Called from `main.ts` right after `createSessionManager` for `getSessionsDir()` (+ custom `sessionDir` when set), wrapped in try/catch; deletions logged via new `appendDebugLog()` in `config.ts` (appends to `~/.lunr/agent/lunr-debug.log`, never throws).
- Setting — `sessionRetentionDays` (default 30, 0 = keep forever) in `Settings` + `getSessionRetentionDays()`/`setSessionRetentionDays()` (invalid values fall back to 30); numeric /settings row "Session retention" (values 0/7/14/30/60/90/365) next to "Smooth streaming".
- Test — new `test/session-retention.test.ts` (6 tests: old-vs-new in project subdir, flat layout, non-jsonl ignored, excludeFile kept, retention 0 keeps all, missing root no-throw) using mkdtemp + utimesSync.

### Verification
- Build: agent → coding-agent → orchestrator clean (exit 0; tsgo re-run after biome autofixes also clean). `ai` not rebuilt.
- `npx biome check packages/` — clean (802 files; 2 noImplicitAnyLet fixes + import-sort/line-wrap autofixes applied).
- Tests: coding-agent vitest — Test Files 88 failed | 86 passed | 2 skipped (176); Tests 56 failed | 988 passed | 21 skipped (1065). Identical to baseline (88/56) plus the 6 new retention tests (982→988, 175→176 files). No NEW failures.
- Retention logic verified by the unit tests (temp sessions dir, real mtimes) — serves as the tsx-harness equivalent. Auto-name LLM call verified statically only (needs a live model); wiring reviewed: `agent_end` → `maybeAutoNameSession` → `modelRuntime.complete` → `setSessionName`.

### Deviations from plan
- "Debug-log deletions only" implemented via a new `appendDebugLog()` helper in `config.ts` (there is no existing debug logger in core; `/debug` writes a snapshot file, not a log). Same helper used for auto-name error swallowing.
- Retention scan covers both the default sessions root AND a custom `sessionDir` (flat layout) — plan only said "sessions root"; custom dirs would otherwise never be pruned.
- Auto-name additionally skips resumed unnamed sessions that already have >1 user message (plan said "first assistant response in an unnamed session") — avoids surprise renames of old sessions.
- Live interactive verification (auto-title after turn 1, /sessions picker in a pty) NOT performed — no live model/pty. Static + unit verification only.

## 2026-07-19 — Phase 6: /undo and /redo (in-session v1)

### What changed
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  - New `redoStack: string[]` field (leaf entry ids; in-memory only, never persisted).
  - Dispatch branches for `/undo` and `/redo` right after `/tree` (same clear-editor-then-handle pattern).
  - `handleUndoCommand()`: `isStreaming` guard (same pattern as /init); walks `sessionManager.getBranch()` (root→leaf) for the last `type === "message" && role === "user"` entry; navigates via `session.navigateTree(target, {})` — same machinery as /tree, no summarization. Pushes the pre-navigation leaf onto `redoStack` only on success; UI refresh copies /tree exactly (`chatContainer.clear()` + `renderInitialMessages()` + editorText-to-editor-if-empty + `flushCompactionQueue`).
  - `handleRedoCommand()`: `isStreaming` guard; pops the stack (empty → "Nothing to redo"); navigates back; re-pushes the id if an extension cancels the navigation; same UI refresh.
  - Redo stack cleared in the `message_start` handler for `role === "user"` — fires for editor submits, queued/steered messages, and command-sent messages (/init, /swarm, /research), so any new user message kills redo.
- `packages/coding-agent/src/core/slash-commands.ts`: `undo` + `redo` entries in `BUILTIN_SLASH_COMMANDS` after `tree`.

### How /undo finds the target
Last user message on the current branch. Two cases: (1) normal — target the user message entry itself; `navigateTree` treats user-message targets as "leaf = parentId, text back to editor", which also handles the root case (first turn → `resetLeaf`, leaf null) and restores the undone prompt into the editor for editing/resending. (2) leaf IS the user message (sent but aborted before any response) — targeting it would be a navigateTree no-op, so target its parentId directly; parentId null → "Nothing to undo".

### Edge cases handled
No user message / empty session → "Nothing to undo". Multiple consecutive undos walk further back each time (each pushes its own redo entry). Redo with empty stack → "Nothing to redo". Both commands blocked while streaming (warning, like /init). Extension-cancelled navigation: undo pushes nothing, redo restores the popped id. New user message clears the redo stack.

### Known limitation (documented)
Undone turns REAPPEAR after restart — session JSONL is append-only and navigateTree only moves the in-memory leaf. Persistent undo via `createBranchedSession` is deferred.

### Verification
- Build: agent → coding-agent → orchestrator clean (exit 0). `ai` not rebuilt.
- `npx biome check packages/` — clean (802 files).
- Tests: coding-agent vitest — Test Files 88 failed | 86 passed | 2 skipped (176); Tests 56 failed | 988 passed | 21 skipped (1065). Byte-identical to the Phase 5 baseline — no NEW failures.
- Logic harness (plain node against dist, deleted after use): 6 scenarios all PASS — plan's exact 3-turn undo ×2 / redo ×2 restore, no-user-message, only-turn-to-root + redo, aborted-stream (leaf is user message) undo, editorText restoration, redo-stack-clear. Harness note: a bare `dist/index.js` entry trips the known ashxj-tui circular-import TDZ; importing `dist/main.js` first (like the real cli.js entry) works under plain node. vitest AND tsx both fail here — tsx remaps `@earendil-works/pi-coding-agent` to src via the root tsconfig paths.

### Deviations from plan
- Plan said "navigate to the entry id before the last user message"; implemented by targeting the user message entry itself, which yields the identical leaf position (parent of the message) and additionally restores the undone text into the editor and handles the root case (`parentId === null` can't be passed as a targetId). Redo pushes/targets the old leaf exactly as planned.
- No live TUI verification (no pty / live model) — harness + static verification only.

## 2026-07-19 — Phase 7: /usage command + plan usage service + footer limit bar

### What changed
- **7a — `packages/coding-agent/src/core/usage-service.ts`** (new): `PlanUsageWindow`/`PlanUsage` types, `getPlanUsage(providerId, runtime)` with a 5-minute per-provider cache (failures cached too — no endpoint hammering), `hasPlanUsageAdapter`, `clearPlanUsageCache`, and `registerUsageServiceBridge(runtime)` exposing `{ getPlanUsage, isOAuthProvider }` on `globalThis[Symbol.for("@lunr/usage-service")]` (same bridge pattern as plan-2's model-tiers). Never throws — every adapter/network error resolves to `undefined`.
- **`core/usage-adapters/shared.ts`** (new): `fetchWithTimeout` (10s), tolerant `asObject/asString/asNumber`, `toEpochMs` (sec/ms/ISO), `unwrapVal` (protobuf-json `{val}`), `usedPercentFrom{Remaining,Used}`.
- **`core/usage-adapters/openai-codex.ts`** (new, VENDORED): consolidated pi-auth HTTP query path + backend normalization from `extension-repos/narumiruna-pi-extensions/extensions/pi-codex-usage/src/{query,normalize,types}.ts` (identical to the Phase-1-deleted baked-in copy). App-server fallback dropped; `ExtensionContext`/`modelRegistry` rewired to core `ModelRuntime` (`getAvailableSnapshot()`/`getModels()` → `runtime.getAuth(model)`); provenance comment at top. No runtime dependency on the deleted extension or extension-repos.
- **`core/usage-adapters/kimi-coding.ts`** (new): `GET https://api.kimi.com/coding/v1/usages`, Bearer API key from `runtime.getAuth("kimi-coding")`. Windows: top-level `usage` → Weekly, `limits[]` (`window.duration/timeUnit` + `detail.limit/remaining/resetTime`) → `5h`-style labels. Shape cross-checked against openchamber/paseo implementations.
- **`core/usage-adapters/zai.ts`** (new): `GET https://api.z.ai/api/monitor/usage/quota/limit`, Bearer API key. `data.limits[]` (`TOKENS_LIMIT` → unit 1/3/5/6 = d/h/m/Weekly; `TIME_LIMIT` → Monthly), `planLabel` from `planName/plan/level`. Shape cross-checked against openclaw/ai-usagebar.
- **`core/usage-adapters/xai.ts`** (new): `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, OAuth access token as Bearer. Monthly-included and on-demand credit windows from the protobuf-json `config` blob. Any failure → `undefined` (pay-as-you-go has no quota).
- Deliberately NO adapters: **anthropic** (policy decision 2026-07-18), **ollama-cloud** (no API exists) — both resolve to `undefined`.
- **7b — /usage**: `BUILTIN_SLASH_COMMANDS` entry; dispatch branch after `/session`; `handleUsageCommand()` in interactive-mode.ts aggregates `sessionManager.getEntries()` assistant usage per `provider/responseModel ?? model` (input includes cache read/write, matching /session), pulls `this.session.getContextUsage()`, and calls `getPlanUsage(this.session.model?.provider, this.session.modelRuntime)`. Renders via new **`modes/interactive/components/usage-view.ts`** (`renderUsageBox` + exported `usageBar`/`formatResetCountdown` helpers): `╭ Usage ─╮` bordered box, `theme.fg("border", …)` rails, 20-cell `█/░` bars, `formatTokens` counts, truncates to `ui.terminal.columns`.
- **7c — `builtin-extensions/ashxj-tui.ts`** (`// lunr:` edits on top of plan-2's status-key edit in `renderStatsLine`): plan-usage state + `ensurePlanUsage()` driven from the footer render path (fire-and-forget, in-flight guard, 5-min local refresh window on top of the service cache, NO new timers); state reset on `session_shutdown`. Cost segment rules: OAuth session + adapter data → `5h 71%·rst 2h51m` (shortest-reset window); OAuth session + NO data → `$` segment dropped; API-key provider → `$x.xxx` unchanged.
- **`main.ts`**: `registerUsageServiceBridge(modelRuntime)` right after `registerModelTierBridge(settingsManager)` — the bridge is read live at render/event time, so a single registration after services exist suffices.
- **`test/usage-service.test.ts`** (new, 20 tests): adapter normalization for all four adapters against fixture payloads (incl. the vendored codex wham/usage normalize), request URL/auth-header assertions, 5-min cache (hit, failure-caching, TTL expiry via fake timers), undefined-on-error paths (no adapter, no credentials, fetch reject, non-200, malformed JSON, empty windows), and `renderUsageBox` (all sections, rectangular box, plan omission, narrow-terminal truncation, empty session) + bar/countdown helpers.

### Wiring choices
- **Extension→core call**: globalThis Symbol bridge (`@lunr/usage-service`), not a direct import. ashxj-tui deliberately imports nothing from core except the `CustomEditor` barrel value (file-header comment documents why); a new core import would also pull `model-runtime` into the extension module graph. The bridge mirrors plan-2's model-tiers precedent and keeps the upstream diff minimal.
- **OAuth-vs-API-key detection**: `runtime.isUsingOAuth(providerId)` — the ModelRuntime snapshot's `AuthCheck.type === "oauth"` (auth.json credential type), surfaced through the bridge as `isOAuthProvider`.
- **zai Authorization header**: sent as `Bearer <key>`. Evidence conflicts (ai-usagebar claims bare-key-only, openclaw + CodexBar use Bearer); Bearer chosen by majority of working implementations. A 401 just yields `undefined` — flagged as a live-verification item.
- **Footer "shortest window"**: window with the soonest `resetsAt` (`undefined` resets sort last) — the window that throttles first.

### Verification
- Build: agent → coding-agent → orchestrator clean (exit 0). `ai` not rebuilt.
- `npx biome check packages/` — clean (810 files; autofixes applied for import sort/line-wrap + one noImplicitAnyLet).
- Tests: `test/usage-service.test.ts` 20/20 PASS under vitest (its import graph — usage-service + adapters + usage-view + theme — avoids the known ashxj-tui circular-import issue, so no plain-node harness was needed).
- Full coding-agent suite: Test Files 88 failed | 87 passed | 2 skipped (177); Tests 56 failed | 1008 passed | 21 skipped (1085) — identical failures to the baseline (88 load-failures / 56 failed), with exactly +20 passed / +1 file from the new usage-service tests. No NEW failures. (One earlier run showed 999 passed/86 files — pre-existing flakiness; the clean re-run above is the comparable number.)
- Live provider APIs NOT tested (no credentials/network here) — normalization covered by fixture payloads derived from the vendored code and three independent open-source implementations per provider.

### Deviations from plan
- Plan's adapter list said kimi-coding "with stored API key" — implemented via `runtime.getAuth(providerId)` which covers stored keys, env keys, and runtime keys uniformly.
- Codex adapter labels windows from `limit_window_seconds` (Weekly/5h) rather than hardcoding, so additional rate-limit buckets would also label sanely (only the primary `codex` snapshot is rendered, though).
- Plan section header shows the plan label when known: `Plan usage (plus)`.
- Footer refetch is render-driven (checks a 5-min local timestamp on each footer render) instead of model_select-only — model_select alone would never refresh on session start or over time; renders are frequent enough and the service cache dedupes the network.

## 2026-07-19 — Phase 8: one-click local providers (Ollama, LM Studio)

### What changed
- **`packages/coding-agent/src/builtin-extensions/lunr-local-providers/local-servers.ts`** (new, lunR-native, NO `@ts-nocheck`): pure, runtime-import-free probing/normalization — `LocalServerSpec` + `OLLAMA_LOCAL` (`http://localhost:11434/v1`, dummy key `"ollama"`, fallback `GET /api/tags`) and `LM_STUDIO` (`http://localhost:1234/v1`, dummy key `"local"`); `extractModelIds` normalizes OpenAI `{data:[{id}]}`, Ollama `{models:[{name}]}`, string entries, deduped; `fetchJson` (hard timeout, never throws); `fetchLocalModelIds` (`/v1/models` → `/api/tags` fallback → null when unreachable); `toModelConfig` defaults (32k ctx, 8k maxTokens, zero cost, `["text"]`, non-reasoning).
- **`builtin-extensions/lunr-local-providers/index.ts`** (new): registers both providers via `pi.registerProvider` with `api: "openai-completions"`, an empty initial model list, `refreshModels` that re-probes localhost (never throws; offline → `[]` → provider unavailable), and an `oauth` block used as a keyless-credential mechanism (see Wiring choices). One-click login: probe (3s) → unreachable throws `"... not detected on localhost:<port> — start it and retry."`; reachable-but-empty throws a "no models, load one and retry" error; success stores `{refresh, access, expires: 2100-01-01}` via the standard `Models.login` → `CredentialStore.modify` persistence path, sets a `justLoggedIn` flag consumed by the next refresh to poll the availability snapshot (100ms, 5s cap, `unref`'d) and `pi.setModel(first)` only when the current model is undefined or the `unknown` placeholder (mirrors `completeProviderAuthentication`). `session_start`/`model_select` keep a `lastCtx` fresh for the auto-select.
- **`builtin-extensions/index.ts`**: `ext("lunr-local-providers", lunrLocalProviders)` — hidden from the startup Extensions list by the existing `<inline:` path filter.

### Wiring choices
- **Dummy credential via the extension `oauth` config, NOT `AuthStorage.modify` directly.** `composeApiKeyAuth` gives oauth-only extension providers no fabricated API-key prompt, so /login shows "Ollama (local)"/"LM Studio (local)" under "Sign in with an account" and selecting one runs our prompt-free `login(callbacks)` — a genuine one-click flow inside the stock dialogs (failure surfaces as `Failed to login to <name>: <probe message>`). `Models.login` itself persists the returned credential through `CredentialStore.modify`, so no direct AuthStorage touch was needed; `getApiKey()` returns the dummy key for requests; `refreshToken` is identity; `expires` is far-future so no refresh is ever attempted. Omitting a literal `apiKey` from the provider config keeps the provider unconfigured (unavailable) until login, exactly matching the plan's offline/unavailable requirement.
- **`refreshModels` probes even when `context.allowNetwork` is false** — localhost connection-refused fails in ~ms, so the registration-time offline refresh (`registerProvider` → `refresh({allowNetwork:false})`) still populates models for a returning logged-in user. No persistent models-store usage; the list is re-probed on every refresh.
- **Auto-select is poll-based from the extension** because `defaultModelPerProvider` only covers `KnownProvider`s, so `completeProviderAuthentication` cannot select for us (it shows its "no default model" note when the previous model was the `unknown` placeholder; our poll then selects the first model — acceptable minor UX overlap).

### Known quirk (documented, not fixed)
- Ollama tool-calling over the OpenAI-compatible `/v1` endpoint can break streaming for some models — noted in the extension file header.

### Verification
- Build: agent → coding-agent → orchestrator clean (exit 0). `ai` not rebuilt.
- `npx biome check packages/` — clean (810 files).
- `npx lunr --version` — 0.80.10; dist contains `builtin-extensions/lunr-local-providers/{index,local-servers}.js`.
- Harness (plain node + mock `http` server against dist, kept at `.pi-subagents/test-local-providers.mjs`, untracked): 9/9 PASS — `/v1/models` listed; `/v1/models` 404 → `/api/tags` fallback normalized; normalization edge cases (dedupe, string entries, garbage); `toModelConfig` defaults; server down → null in 2ms (no hang); blackhole server → null after the 400ms test timeout. No circular-import issue: `local-servers.ts` has type-only barrel imports (erased), so the dist module loads standalone.
- Full coding-agent suite: Test Files 88 failed | 87 passed | 2 skipped (177); Tests 56 failed | 1008 passed | 21 skipped (1085) — byte-identical to the Phase 7 baseline. No NEW failures.
- Live verification PENDING: no real Ollama/LM Studio install here — the actual /login → probe → credential → auto-select path against a live server is untested (logic covered by harness + code-path recon only).

### Deviations from plan
- Plan said save the dummy credential "via `AuthStorage.modify` (or whatever the provider-auth API exposes)" — used the oauth login flow, where `Models.login` performs the store write itself (cleaner; no core imports in the extension).
- Plan said "auto-select first model (mirror `completeProviderAuthentication`)" — auto-select only fires when no real model is active (the mirror's exact condition), via a short availability poll from the extension rather than inside the core login completion.
- `maxTokens` 8192 (plan specified only 32k ctx / zero cost / text modalities).

## 2026-07-19 — Phase 9: /context breakdown (salvaged from quota-killed subagent, completed by parent)

### What changed
- `packages/coding-agent/src/core/context-breakdown.ts` (new): pure `computeContextBreakdown({systemPrompt, tools, messages, contextWindow})` — chars/4 estimates (same heuristic as `estimateTokens` in compaction.ts). Categories: system prompt (project context files baked in), tool definitions (name+description+JSON schema), user/custom messages, assistant text, thinking, tool calls, tool results, summaries (branch+compaction), total, free. Pass `AgentSession.messages` so post-compaction renders match reality.
- `packages/coding-agent/src/modes/interactive/components/context-view.ts` (new): `renderContextBox` — per-category 20-cell bar rows, estimated-total row with `used / window (pct)`, free row, "Estimated (chars/4)" disclaimer. Shares box chrome with /usage.
- `usage-view.ts`: box chrome extracted into exported `renderThemedBox(headerText, content, maxWidth)`; `renderUsageBox` now delegates.
- `interactive-mode.ts`: `/context` dispatch + `handleContextCommand()` (`// lunr:` comment) — guards on missing model/contextWindow, pulls active tool definitions via `getActiveToolNames()`/`getToolDefinition()`, renders into chatContainer.
- `core/slash-commands.ts`: `context` entry.
- `test/context-breakdown.test.ts` (new, 9 tests).

### Verification
- Subagent was killed by provider quota mid-phase; parent verified and landed the work: biome import-sort/format fix in interactive-mode.ts, rebuild clean (exit 0), biome clean (813 files), targeted tests 9/9 pass, full suite no new failures (see commit).
- The plan's "~10% of getContextUsage()" cross-check not performed (no live session) — estimates use the identical chars/4 heuristic, so drift is structural (tool defs/system prompt included here, excluded from message-only counts), documented in the box disclaimer.

### Deviations
- None in scope. Live TUI verification pending (no pty).

## 2026-07-20 — Phase 10: todo compact display setting — RECON ONLY, NO IMPLEMENTATION

### Recon findings: there is NO todo tool or todo renderer in this build

Searched `packages/coding-agent/src/core/tools/` (tool list: bash, edit, find, grep, ls, read, write — no todo),
all of `packages/coding-agent/src/builtin-extensions/`, and `packages/agent/src` for
`todo`/`TodoList`/`TodoWrite`/`in_progress`/`task list`. Hits found, none are a live todo surface:

- `packages/coding-agent/examples/extensions/todo.ts` — an EXAMPLE extension (`todo` tool + `/todos`
  command + `TodoListComponent`). Lives under `examples/`, is not in `builtin-extensions/`, is not
  registered by `main.ts`, and is never loaded at runtime in this build.
- `packages/coding-agent/examples/extensions/plan-mode/` — another example (todo-list widget with
  `[DONE:id]` markers). Also not loaded.
- `builtin-extensions/context-mode/session/extract.ts` + `adapters/{claude-code,qwen-code}` — mention
  `TodoWrite`/`todo_write`/`TaskCreate`/`TaskUpdate` only as tool-name matchers when IMPORTING foreign
  agents' session histories (hooks/adapters for claude-code and qwen-code). Not a lunR tool, renders
  nothing in the TUI.
- `builtin-extensions/narumiruna-pi-goal/src/prompts.ts` — the word "TODO" in prompt text only.
- `pi-ollama-cloud/index.ts` — a `TODO:` code comment only.

Conclusion: the user sees no todo list during runs today — there is no todo tool for the agent to call
and no todo renderer in the TUI. Per the task's explicit fallback instruction ("do NOT invent one"),
no `todoDisplay` setting, no /settings row, and no renderer were added. No code was changed and no
commit was made; this progress entry is the only artifact (left uncommitted for user decision).

Options if this phase is to proceed later: (a) bake the `examples/extensions/todo.ts` example in as a
built-in extension and add the compact mode to its `renderResult`/`TodoListComponent`, or (b) drop
Phase 10 entirely.

## 2026-07-20 — Phase 11: ashxj-thinking bake-in

### What changed
- Cloned `https://github.com/ashx-j/ashxj-thinking` @ `0330a34` ("Remove custom footer — keep only
  /thinking command") into `extension-repos/` (gitignored, not committed). Upstream is a single-file
  extension (`index.ts`, ~340 lines, structural types, no runtime deps — only node builtins; peer dep
  on pi-coding-agent only). It registers `/thinking [level]` (picker via `ctx.ui.select` + direct set
  via `pi.setThinkingLevel`) and `/thinking show|hide|toggle` (persists `hideThinkingBlock` to the
  global settings.json, then `await ctx.reload()` live-applies it).
- `packages/coding-agent/src/builtin-extensions/ashxj-thinking.ts` (new): verbatim vendored copy with
  `// @ts-nocheck` + vendored-from header (house convention). Three `// lunr:` patches:
  1. `agentSettingsPath()`: upstream hardcoded `~/.pi/agent/settings.json` → now honors
     `PI_CODING_AGENT_DIR` (with the same leading-`~` expansion as core `normalizePath()`) and falls
     back to `~/.lunr/agent/settings.json`. Without this, `/thinking hide` would have written into
     pi's config dir where lunR's SettingsManager never reads (verified core path:
     `SettingsManager.create` → `FileSettingsStorage(cwd, getAgentDir())` → global scope =
     `$PI_CODING_AGENT_DIR/settings.json` or `~/.lunr/agent/settings.json`).
  2. Added `"max"` to the `ThinkingLevel` union + level list + descriptions (mirrors
     settings-selector.ts) — lunR's ThinkingLevel includes `max`, upstream (written for pi 0.80.3)
     didn't. Per-model filtering via `thinkingLevelMap` null entries still applies.
  3. Notify messages now reference the resolved path instead of the hardcoded `~/.pi/...` string.
- `builtin-extensions/index.ts`: `import ashxjThinking` + `ext("ashxj-thinking", ashxjThinking)`.
- NO deps added: upstream imports only `node:fs`/`node:path`/`node:os` (`unicode-animations` not used).
- NO color patches needed: the extension renders no colors (plain `● ` current-marker in the picker,
  text-only notifies). moon.json `thinkingText: "gray"` already covers thinking-block rendering.

### Coexistence findings (plan step 5)
- `hideThinkingBlock`: `/thinking show|hide|toggle` writes the same setting key core uses
  (`settings-manager.ts` `getHideThinkingBlock`/`setHideThinkingBlock`). In TUI mode `ctx.reload()`
  → `handleReloadCommand()` → `restoreChatBeforeSessionStart()` re-reads the setting and rebuilds
  every AssistantMessageComponent (interactive-mode.ts ~5686) — the upstream live-apply mechanism
  works unmodified in lunR. Ctrl+T keybinding (`toggleThinkingBlockVisibility`) untouched; both paths
  write the same key so they stay in sync after any reload. Caveat (pre-existing upstream design):
  the in-memory Ctrl+T toggle is not re-read until a reload, so Ctrl+T after `/thinking hide` in the
  same session flips from the in-memory value — same behavior as upstream pi.
- smoothStreaming: `smooth-streaming.ts` reveals text+thinking grapheme-by-grapheme; `/thinking`
  never touches streaming state, only the persisted visibility flag + reasoning level. No conflict.
- Phase 4 `● ` first-text-block prefix: applies to text blocks only, never thinking blocks
  (assistant-message.ts:104-107); thinking blocks render via `theme.fg("thinkingText", ...)`.
  Unaffected.

### Verification
- Build: agent → coding-agent → orchestrator clean (exit 0). `ai` not rebuilt.
- `npx biome check packages/` — clean (813 files; builtin-extensions is biome-excluded).
- `/thinking` in dist: `dist/builtin-extensions/ashxj-thinking.js` contains
  `registerCommand("thinking", ...)`; `dist/builtin-extensions/index.js` imports + registers
  `ext("ashxj-thinking", ...)`; dist file carries the `PI_CODING_AGENT_DIR`/`.lunr` patch.
- Full coding-agent suite: Test Files 88 failed | 88 passed | 2 skipped (178); Tests
  56 failed | 1017 passed | 21 skipped (1094) — byte-identical to the post-Phase-9 baseline.
  No NEW failures.
- Live TUI verification pending (no pty): picker, select, and reload round-trip untested live.

### Deviations
- Plan said patch colors "if it hardcodes any" — it hardcodes none; nothing patched.
- The `max`-level addition goes beyond the plan text but is required for correctness against lunR's
  ThinkingLevel union (otherwise `/thinking` could never show/set `max`).

## 2026-07-20 — Phase 12: native plan mode (/plan) with read-only tool gating

Phase 1 deleted narumiruna-pi-plan-mode, so plan mode is rebuilt NATIVE in core (simplified
vs the extension: no tool picker, no completion/question tools, no state persistence).

### Implementation
- `core/plan-mode.ts` (new, pure module): `PLAN_MODE_ADDENDUM`, `PLAN_MODE_BLOCK_MESSAGE`,
  `planModeBlockReason(toolName, input)` (blocks edit/write always; bash via heuristic),
  `isMutatingBashCommand(command)`. Heuristic is a conservative BLOCKLIST (documented in
  the file header, "not a security boundary"): unquoted `>`/`>>` redirects; segment split on
  `;` `|` `&` (quote-aware); per-segment leading command — known mutating commands
  (rm/mv/cp/mkdir/touch/chmod/ln/tee/dd/sed -i/find -delete|-exec/…), git limited to
  read-only subcommands (branch/tag/remote flag-only), package managers limited to
  read-only subcommands (install/add/remove/update/publish blocked), arbitrary runners
  (sudo/xargs/npx/sh -c/apt/brew/…) blocked. Unknown unlisted commands are ALLOWED.
- `core/agent-session.ts`: new core-owned interception independent of extensions —
  `addToolCallGate(gate)` (unsubscribe fn) + `ToolCallGate` type; gates run FIRST in
  `agent.beforeToolCall` even when no extension handles `tool_call` (extension runner
  short-circuits without handlers, so the extension path alone couldn't host this).
  Blocked → `{block:true, reason}` → agent loop emits an error tool result to the model.
  `setSystemPromptAppend(text|undefined)` + `_withSystemPromptAppend()` applied at all 4
  effective-prompt sites (next-turn refresh, setActiveTools rebuild, before_agent_start
  base+override branches, resource reload) — addendum stacks on top of extension overrides.
- `interactive-mode.ts`: `planModeActive` + `planModeCleanup` fields (in-memory v1, NOT
  persisted); `/plan` dispatch + `handlePlanCommand(args)` with on|off|status (bare
  toggles, unknown arg → usage, isStreaming guard on state changes matching /undo /swarm).
  Entering registers the gate + `setSystemPromptAppend(PLAN_MODE_ADDENDUM)` + footer
  `setExtensionStatus("plan", "plan ● read-only")`; exiting reverses all three. Plan mode
  is CLEARED in the `setBeforeSessionInvalidate` callback (gate/addendum live on the
  AgentSession being replaced by /new, /resume, etc.).
- `core/slash-commands.ts`: `/plan` entry (`[on|off|status]` hint).
- `builtin-extensions/ashxj-tui.ts` (`// lunr:`): `"plan"` added FIRST in the footer status
  key list `["plan","goal","swarm","research","lsp","mcp","tps"]`.
- `core/system-prompt.ts`: one permanent paragraph — for complex multi-file tasks, propose
  entering plan mode first (model-driven auto-suggest, no heuristics).

### Tests
- `test/plan-mode.test.ts` (new): 11 tests — planModeBlockReason (edit/write blocked,
  reads open, bash allowed/blocked + reason includes command, defensive missing command)
  and isMutatingBashCommand (read-only allowed incl. quoted `>`, env-prefix, pipes;
  mutating blocked incl. redirects, git subcommands, package installs, runners,
  mutation hidden in later segments). Pure-module test, no circular-import issue.

### Verification
- Build: agent(pi-agent-core) → coding-agent → orchestrator clean (exit 0). `ai` not rebuilt.
- `npx biome check packages/` — clean (815 files; biome format applied to the 3 new/edited files).
- Suite: Test Files 88 failed | 89 passed | 2 skipped (179); Tests 56 failed | 1028 passed |
  21 skipped (1105) — baseline 88/56/1017/21 (1094) + my 11 new tests all passing. No NEW failures.
- Static: dist/core/plan-mode.js emitted; dist agent-session carries _toolCallGates (5x),
  _withSystemPromptAppend (7x), addToolCallGate, setSystemPromptAppend; dist interactive-mode
  carries handlePlanCommand + "plan ● read-only"; dist ashxj-tui carries "plan" first in keys.

### Deviations / limitations
- Simpler than the extension: no `/plan tools` selector, no plan_mode_complete/question
  tools, no <proposed_plan> parsing, no per-branch state persistence, no thinking-level
  override. Blocklist bash heuristic (not the extension's allowlist) — documented.
- Plan mode does not survive session replacement (/new, /resume) — cleared on invalidate.
- Live TUI run pending (static + unit verification only).
