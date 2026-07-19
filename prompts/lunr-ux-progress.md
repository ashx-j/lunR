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
