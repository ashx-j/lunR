# lunR Features: /swarm, /research, Smooth Streaming, Model Tiers, Goal Indicator, /init

## Goal

Add six features to lunR:
1. `/goal` active indicator in the footer: `[goal ● active · 1m · 1 turn]`
2. `/init` command: scan the codebase, generate a starter AGENTS.md
3. Smooth streaming setting: thinking/text reveal character-by-character instead of chunk-flash
4. 3-tier model settings (light / standard / heavy) integrated into subagent model selection
5. `/swarm` command: orchestrated multi-agent mode via the baked-in pi-subagents extension
6. `/research` command: deep research loop with citations via pi-subagents + pi-web-access

All file paths and line numbers were verified by codebase recon on 2026-07-18. Re-read any
file before editing it.

## Prerequisites — READ FIRST

- **Plan 1 (`prompts/lunr-basics-plan.md`) may still be running in another session.** It edits
  `interactive-mode.ts`, `settings-selector.ts`, `settings-manager.ts`, and theme files —
  the same files this plan touches (Phases 1-3). Do NOT start Phases 1-3 until that goal is
  complete and merged. Phases 4-6 (extensions + new files) have less overlap but still touch
  `interactive-mode.ts` for command dispatch. Confirm git state before starting; rebase this
  work on top of the finished basics branch.
- Work on a branch: `feat/lunr-agent-features`. One commit per phase.
- After finishing, update `AGENTS.md` Current State with results and decisions.
- Do NOT touch `~/.pi/`. lunR config is `~/.lunr/`.
- `packages/coding-agent/src/builtin-extensions/` is upstream code with `// @ts-nocheck`.
  This plan requires small, marked edits there (Phases 3, 5, 6 and the ashxj-tui footer).
  Keep them minimal, wrap each edit with `// lunr: <reason>` comments, and record every one
  in AGENTS.md so future upstream syncs can re-apply them.

## Key recon findings that drive the design

- Kimi CLI has **no real swarm command**: swarm on kimi.com is server-side/model-native.
  Locally, kimi-cli just has an `Agent` tool with subagent types (coder/explore/plan), each
  running a local agent loop. lunR's baked-in pi-subagents already exceeds this (single /
  parallel / chain modes, background runs, fleet inspector, model overrides). **/swarm is a
  prompt-and-mode layer on top of pi-subagents, not new orchestration machinery.**
- Kimi CLI has **no deep research mode** either: research = generic agent loop + explore
  subagent + web tools. Best-practice loop (Open Deep Research, GPT Researcher):
  scope → plan → parallel search/read per subtopic → reflect → iterate (depth/breadth/budget
  caps) → one-shot synthesis with inline citations.
- **Footer is single-owner**: ashxj-tui installs a custom footer via `ctx.ui.setFooter()` and
  only renders extension statuses with keys `lsp`, `mcp`, `tps` (`ashxj-tui.ts:519-527`).
  pi-goal already publishes its status via `ctx.ui.setStatus("goal", ...)` — it just never
  displays. Fix = teach ashxj-tui to render the `goal` key + enrich pi-goal's status string.
- **Extensions cannot add /settings menu entries** (no API). The model-tier menu must be
  core code in `settings-selector.ts`.
- Slash commands: add to `BUILTIN_SLASH_COMMANDS` (`core/slash-commands.ts:19-44`) + dispatch
  branch in `setupEditorSubmitHandler()` (`interactive-mode.ts:2595-2722`) + handler method.
- Verified open issue: `BUILTIN_AGENTS_DIR` for pi-subagents resolves to
  `builtin-extensions/pi-subagents/agents` which **does not exist in the source tree**, yet
  built-in agents (scout, worker, etc.) work at runtime. Phase 4 must first locate where the
  built-in agent .md files actually live (check `dist/`) before adding new agent definitions.

---

## Phase 1 — /goal footer indicator

pi-goal state: `ActiveGoal` in `builtin-extensions/narumiruna-pi-goal/src/persistence.ts:28-41`
has `id, text, status, startedAt, iteration, tokensUsed, timeUsedSeconds, activeStartedAt`.
`GoalRuntime.updateStatus()` (`runtime.ts:650-655`) calls `ctx.ui.setStatus("goal", formatStatus(goal))`.
`formatStatus` (`runtime.ts:565-580`) currently returns plain words like `active`, `paused`.

### Changes (both files are baked-in upstream; mark edits with `// lunr:`)

1. **`builtin-extensions/narumiruna-pi-goal/src/runtime.ts`** — rewrite `formatStatus(goal)`
   to emit the target format:
   ```
   [goal ● active · 3m · 2 turns]
   [goal ◌ paused · 12m · 5 turns]
   ```
   - `●` for active, `◌` for paused, `✓`/`✗` briefly for complete/blocked (existing 8s
     completion display already handles those — keep it).
   - Elapsed: from `goal.activeStartedAt ?? goal.startedAt`, minus paused time if tracked;
     `timeUsedSeconds` if it is the maintained accumulator. Format `Xm` under 1h, `XhYm` after.
   - Turns: `goal.iteration`, singular "turn" at 1.
2. **`runtime.ts`** — add a 30s `setInterval` while a goal is active that re-calls
   `updateStatus()` so the minutes tick. Clear it on pause/complete/blocked/clear and in the
   extension's dispose path (the completion-status timer pattern at `runtime.ts:690-710`
   shows how timers are already managed).
3. **`builtin-extensions/ashxj-tui.ts:519-527`** — extend the rendered status keys:
   ```ts
   for (const key of ["goal", "lsp", "mcp", "tps"] as const) {
   ```
   Goal first so it leads the line. No other ashxj-tui changes.

### Verify
- Build; run `npx lunr`, `/goal test goal`, footer shows `[goal ● active · 0m · 1 turn]`,
  minutes advance within ~30s, `/goal pause` flips to `◌ paused`, `/goal clear` removes it.

---

## Phase 2 — /init command

Pattern: prompt-template command. The main agent already has read/bash/grep tools and writes
files; a one-shot `complete()` call without tools would be worse. Recon: command dispatch at
`interactive-mode.ts:2595`; programmatic prompt via `this.session.sendUserMessage(...)`
(`agent-session.ts:1460-1490`); AGENTS.md auto-loads into the system prompt via
`loadProjectContextFiles` (`resource-loader.ts:68-85`) at session start and on `/reload`.

### Changes

1. **`core/slash-commands.ts`** — add `{ name: "init", description: "Generate a starter AGENTS.md for this project" }`.
2. **`interactive-mode.ts` `setupEditorSubmitHandler()`** — add branch:
   ```ts
   if (text === "/init") { this.editor.setText(""); await this.handleInitCommand(); return; }
   ```
3. **New handler `handleInitCommand()`** in `interactive-mode.ts`:
   - If `AGENTS.md` exists in cwd: ask via the existing confirm/selector UI
     ("AGENTS.md exists — overwrite / append / cancel"). Default cancel.
   - Send the init prompt via `this.session.sendUserMessage(INIT_PROMPT)` where INIT_PROMPT
     is a module-level constant:
     ```
     Analyze this codebase and write a starter AGENTS.md in the project root.
     Scan: package manifests, directory layout, build/test/lint scripts, CI config,
     existing README/docs. Include only: project purpose (one paragraph), build &
     test commands, code style/conventions found, directory map, and agent rules
     (safety: no secrets in commits, no destructive commands without confirmation).
     Keep it under 150 lines. Facts only — if something is unknown, omit it. After
     writing the file, reply with a 5-line summary of what you detected.
     ```
   - After the turn completes, show a `ctx`-style notification: "AGENTS.md created — run
     /reload or restart to load it into context." (Detecting turn end: reuse whatever the
     `/export` flow uses to know the agent finished; simplest acceptable version is to print
     the hint immediately after `sendUserMessage` returns, phrased as "when it finishes".)

### Verify
- Fresh test repo: `/init` produces AGENTS.md with correct scripts/layout; restart `npx lunr`
  and confirm project context is in the system prompt (`/export` or debug log).
- Existing AGENTS.md: overwrite prompt appears; cancel writes nothing.

---

## Phase 3 — Smooth streaming setting

Current pipeline (recon): every model delta fires `message_update` →
`InteractiveMode.handleEvent` (`interactive-mode.ts:2867-2870`) →
`streamingComponent.updateContent(fullMessage)` → `requestRender()`. No buffering anywhere.
`AssistantMessageComponent.updateContent` (`assistant-message.ts:117-180`) rebuilds children
from `message.content` each time.

Design: buffer at the InteractiveMode layer (option 1 from recon — no TUI component changes,
works for both text and thinking blocks since both live in `message.content`).

### Changes

1. **Settings**: add `smoothStreaming?: boolean` to `Settings` in
   `core/settings-manager.ts` (interface ~:83-136) with `getSmoothStreaming()` /
   `setSmoothStreaming()` following the existing getter/setter pattern (:723-748). Default
   `false`.
2. **Settings menu**: add toggle row `smooth-streaming` ("Smooth streaming — reveal
   responses character by character") in `settings-selector.ts` following the `autocompact`
   direct-toggle pattern (:266-436), plus `SettingsConfig`/`SettingsCallbacks` entries, wired
   in `showSettingsSelector()` (`interactive-mode.ts:4073-4170`).
3. **Smoothing logic** in `interactive-mode.ts`:
   - Keep `streamingTargetMessage` (latest from events) and `streamingDisplayedLength`
     (grapheme count revealed so far) alongside the existing `streamingMessage`.
   - On `message_update`: update target only. If smoothing off → current behavior.
   - If on: start a `setInterval` (16-30ms) that advances the revealed length and calls
     `updateContent(sliceMessage(streamingTargetMessage, revealedLength))` +
     `requestRender()`.
   - `sliceMessage`: pure helper that walks `message.content` blocks (text + thinking) and
     returns a shallow copy truncated to N graphemes total. Use a grapheme splitter
     (`Intl.Segmenter`, built into Node) — never split inside a surrogate pair or ANSI-free
     unicode char.
   - **Catch-up acceleration**: reveal `max(base, backlog / 8)` chars per tick so a fast model
     doesn't leave the display far behind. Base rate ~4 chars/tick at 20ms (~200 chars/sec).
   - On `message_end`: clear interval, render the full message immediately.
   - On interrupt/`agent_end`/new user message: clear interval.
   - Timer must not keep the process alive: `timer.unref?.()` — and clear it in
     `shutdown()`.

### Verify
- Setting on: thinking blocks and text type out smoothly; long responses catch up (no
  multi-second lag at end); interrupt works; setting off: current instant behavior.
- `hideThinkingBlock` setting unchanged in both modes.
- No new test failures (tests exercise `initTheme`/`AssistantMessageComponent` directly —
  the component is untouched).

---

## Phase 4 — 3-tier model settings + subagent integration

Tiers: **light** (cheap/fast tasks), **standard** (medium), **heavy** (complex reasoning).
Do NOT put vendor model names in the UI labels — the menu shows "Light tier model",
"Standard tier model", "Heavy tier model", each opening the existing model selector.

### Settings & menu (core)

1. `Settings` + SettingsManager: nested `modelTiers?: { enabled?: boolean; light?: string; standard?: string; heavy?: string }`
   with getters/setters (nested pattern like `terminal.showImages`, `settings-manager.ts:1063-1077`).
   Values are `provider/model` strings as used by `/model`.
2. `settings-selector.ts`: new "Model tiers" submenu (follow `ThemeSubmenu`, :183-389):
   row 1 enable/disable toggle; rows 2-4 open a model picker per tier. Reuse the model
   selector list construction from `model-selector.ts` (check what `showModelSelector()`
   at `interactive-mode.ts:4255` uses; factor the list-building into a shared helper if it
   isn't already).
3. Wire in `showSettingsSelector()`.

### Tier → model bridge to pi-subagents

pi-subagents resolves child models in `resolveEffectiveSubagentModel`
(`pi-subagents/src/runs/shared/model-fallback.ts:189-240`), called from three sites:
`subagent-executor.ts:2931-2936` (single), `:2609-2611` (parallel), `chain-execution.ts:1130-1136` (chain).
Explicit `model` param always wins today — keep that.

Bridge via the theme-style global symbol pattern (avoids import cycles, upstream-friendly):

1. **New core module `core/model-tiers.ts`**:
   - `TIER_NAMES = ["light", "standard", "heavy"]`.
   - `getTierModel(tier): string | undefined` reading SettingsManager.
   - `isTierModeEnabled(): boolean`.
   - Registers both on `globalThis` under `Symbol.for("@lunr/model-tiers")` at startup
     (call from `main.ts` near `initTheme`, :613-ish) so the extension can find them without
     importing core.
2. **pi-subagents edits** (minimal, `// lunr:` marked):
   - `extension/schemas.ts:127-181`: add optional `tier: Type.Optional(Type.String({ enum: ["light","standard","heavy"] }))`
     to the subagent tool params (and per-task/per-step items where `model` is allowed).
   - `extension/tool-description.ts` (`buildSubagentToolDescription`): when tier mode is on
     (check the global symbol; absent = off), append: "Model tiers are enabled. For each
     subagent choose `tier`: 'light' for simple lookups/formatting, 'standard' for typical
     coding tasks, 'heavy' for deep reasoning/complex debugging. An explicit `model`
     overrides the tier. Omit both to inherit the parent model."
   - At the three resolution call sites: if `params.tier` set and tier mode enabled and no
     explicit `model`, resolve tier → model string via the global helper, pass as
     `explicitModel` to `resolveEffectiveSubagentModel`. Unknown/misconfigured tier → fall
     back to inherit (log to debug, never throw).
3. **Disabled behavior**: tier mode off → tier param absent from the tool description and
   ignored if passed; resolution behaves exactly as today (inherit parent unless `model`
   given).

### Verify
- Menu: set three models, toggle on. Main session: ask it to "launch a light-tier subagent
  that counts files" — check `/subagents-fleet` or session log shows the tier's model.
- Explicit `model` param beats tier. Toggle off → subagents inherit parent model.
- `models-store.json` unchanged; no network calls added.

---

## Phase 5 — /swarm command

No new orchestration engine: pi-subagents already provides parallel/chain/async/fleet.
`/swarm` is a core command that activates an orchestration stance in the main session.

### Changes

1. **Locate the built-in agent .md files first** (residual risk from recon): find where
   `pi-subagents/agents` lives in `dist/` after build. New agent definitions in Phase 5-6 go
   to the same place in `src/` so the build copies them. If the src dir genuinely doesn't
   exist, create `packages/coding-agent/src/builtin-extensions/pi-subagents/agents/` and
   verify the build's asset-copy includes `*.md` (check `copy-assets` in
   `packages/coding-agent/package.json`; extend it if needed).
2. **`core/slash-commands.ts`**: `{ name: "swarm", description: "Orchestrate parallel subagents for a complex task", argumentHint: "<task>" }`.
3. **Dispatch + handler `handleSwarmCommand(args)`** in `interactive-mode.ts`:
   - No args → show current swarm state (active runs → delegate display to the existing
     `/subagents-fleet` overlay; call its command handler the same way extension commands
     are invoked, or print a hint to use `/subagents-fleet`).
   - `/swarm <task>` → `this.session.sendUserMessage(buildSwarmPrompt(task))`.
   - `buildSwarmPrompt` (module constant, template):
     ```
     [SWARM MODE] Task: <task>
     Act as an orchestrator. 1) Decompose into 3-8 independent subtasks. 2) Launch them
     in ONE parallel subagent call (async:false), picking an agent + model tier per
     subtask (prefer scout for exploration, worker for implementation, reviewer for
     verification). 3) Synthesize the results and report. Rules: max 8 concurrent
     subagents; no nested fan-out; if a subtask fails, retry once with the heavy tier
     before giving up on it; keep your final report under 100 lines with per-subtask
     status.
     ```
4. **Session flag** `swarmMode` (in-memory on InteractiveMode, not persisted): while a swarm
   prompt is in flight, set `this.setExtensionStatus("swarm", "[swarm ● N agents]")` —
   reuse the goal-indicator pattern from Phase 1 (ashxj-tui renders `goal` after Phase 1;
   add `"swarm"` to the same key list). Update N from subagent events if cheap; otherwise
   static `[swarm ● active]` and clear on turn end. Keep this simple — the fleet overlay is
   the real monitor.
5. Caps: the parallel-mode concurrency default lives in pi-subagents config; do not change
   upstream defaults. The prompt enforces the 3-8 decomposition; document in AGENTS.md that
   hard caps need pi-subagents' own config if the model ignores them.

### Verify
- `/swarm refactor the utils folder into modules` → single parallel subagent call visible in
  the tool UI; per-subtask results merged into one report; footer shows swarm status during
  the run.
- `/swarm` alone → fleet/hint. Works with tiers enabled (tier per subtask) and disabled
  (inherits parent).

---

## Phase 6 — /research command (deep research)

Design (from web-research best practices): scope → plan → parallel research per subtopic →
reflect/iterate (depth/breadth/budget caps) → one-shot synthesis with citations. Implement as
a pi-subagents **chain** with two new agent definitions, driven by a core `/research` command.
Web access comes from pi-web-access (`web_search`, `fetch_content`, `get_search_content`).

### New agent files (location determined in Phase 5 step 1)

1. **`deep-researcher.md`** — frontmatter: `description: "Researches one subtopic via web search/fetch and returns cited findings"`, tools restricted to web/search/fetch/read-style tools (read-only, like kimi's explore agent), model tier guidance: standard.
   System prompt essentials:
   ```
   You research ONE subtopic. Use web_search (2-4 varied queries per round, prefer the
   queries array) and fetch_content for primary sources. Rules: cite every claim as
   [N] with the URL in a trailing Sources list; prefer primary/recent sources; reconcile
   conflicts explicitly; if evidence is missing, say "not found" — never invent. Return:
   findings (bulleted, cited), open questions, Sources list. Max 3 search rounds.
   ```
2. **`research-writer.md`** — frontmatter: `description: "Synthesizes research findings into a cited report"`, read-only.
   ```
   You receive findings from multiple researchers. Write one coherent report: summary
   (5 lines), per-subtopic sections with inline [N] citations, conflicts/uncertainty
   section, consolidated Sources list renumbered 1..N. Facts only from the provided
   findings. Under 200 lines.
   ```

### Command

1. `core/slash-commands.ts`: `{ name: "research", description: "Deep research with cited sources", argumentHint: "[--depth N] [--breadth N] <question>" }`.
2. Handler `handleResearchCommand(args)` in `interactive-mode.ts`:
   - Parse flags: `--depth` (reflection rounds, default 2, max 4), `--breadth` (subtopics,
     default 4, max 8). Invalid usage → print usage, no LLM call.
   - Send `buildResearchPrompt(question, depth, breadth)` via `sendUserMessage`:
     ```
     [DEEP RESEARCH] Question: <question>
     Procedure: 1) Write a 3-line research brief decomposing this into <breadth>
     subtopics. 2) Launch <breadth> deep-researcher subagents in ONE parallel call, one
     per subtopic. 3) Reflect: list what's unanswered or conflicting. If gaps remain and
     this is not round <depth>, launch one more parallel round targeting the gaps.
     4) Launch ONE research-writer subagent (chain after the last round) with all
     findings; its output is the final report. 5) Save the report to
     research-<yyyymmdd>-<slug>.md in the cwd and reply with the file path + the
     5-line summary. Hard caps: ≤3 parallel rounds, ≤8 researchers per round, cite or
     delete every claim.
     ```
   - Set extension status `[research ● round N]` during the run (same mechanism as swarm).
3. Prereq check in the handler: pi-web-access needs a search provider key (Brave/Tavily/
   Exa/OpenAI etc.). If `web_search` has no available provider, tell the user to configure
   one (`~/.lunr` settings or env var) instead of failing mid-research. Detect by asking the
   user once — there is no clean sync API; acceptable v1: run and let the first web_search
   error surface, with the hint text included in the prompt's failure rule.

### Verify
- `/research --depth 2 --breadth 3 how does X work` → parallel researchers → one writer →
  `research-*.md` in cwd with inline citations + Sources list; every claim cited or absent.
- Interrupt mid-research stops the chain cleanly (pi-subagents stop path).
- No provider configured → clear error message, no half-written report.

---

## Cross-cutting verification

1. `npm run build` clean; `npx biome check packages/` clean (excluding builtin-extensions
   as already configured — your marked edits there are exempt).
2. `npm test` — no new failures beyond the recorded Windows baseline (tui 12, ai 28,
   coding-agent 34, all environment-specific).
3. Manual matrix: tiers on/off × swarm/research; smooth streaming on/off; goal indicator
   lifecycle; /init on empty and existing-AGENTS.md repos.
4. Update `AGENTS.md` Current State: six features, decisions (prompt-layer swarm, chain-based
   research, symbol-bridge tiers, ashxj-tui status-key edit), every upstream-file edit made,
   known limitations (prompt-enforced caps, no hard swarm limits).

## Definition of done

- Six commits on `feat/lunr-agent-features`, one per phase.
- All six features work per their verify steps.
- Build, biome, tests pass per criteria above.
- `AGENTS.md` Current State updated, including the list of `// lunr:` marked upstream edits.

## Deferred / out of scope

- Hard server-side enforcement of swarm caps (pi-subagents config exists; prompt-level is v1).
- A dedicated swarm TUI dashboard (the `/subagents-fleet` overlay covers monitoring).
- Auto-detection of web-search provider availability before /research.
- Interactive clarify UI for /research scoping (v1 uses the brief in-chat).
