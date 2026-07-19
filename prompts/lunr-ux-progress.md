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
