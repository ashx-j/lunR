# lunR Plan 3: UX fixes, sessions, providers, usage tracking

## Goal

Fourteen changes: boot screen cleanup + new art, simplified subagent view, dot-only status
coloring, session management (auto-name, /sessions, /title, 30-day cleanup), /undo + /redo,
/context breakdown, todo compact display, ashxj-thinking bake-in, plan mode activation,
autocomplete [t] fix + extension settings into /settings, one-click local Ollama/LM Studio,
subscription limit bar replacing the cost meter, and a /usage command.

All file paths and line numbers verified by recon on 2026-07-18. Re-read files before editing.

## Prerequisites — READ FIRST

- **Sequencing**: `feat/lunr-basics` is merged/done. `prompts/lunr-features-plan.md` (plan 2)
  may still be running. This plan touches the same hot spots: `interactive-mode.ts`,
  `settings-selector.ts`, `settings-manager.ts`, and **ashxj-tui.ts's `renderStatsLine`**
  (plan 2 adds the `goal` status key; this plan changes the cost segment). Branch
  `feat/lunr-ux` off master AFTER plan 2 merges, or expect conflicts in ashxj-tui.ts and
  settings files.
- One commit per phase. Update `AGENTS.md` Current State at the end.
- Edits to `src/builtin-extensions/` are upstream code: minimal, `// lunr:` marked, logged in
  AGENTS.md.
- Do NOT touch `~/.pi/`; lunR config is `~/.lunr/`.

## Research verdicts that shape the plan (2026-07-18)

**Subscription usage tracking feasibility:**

| Provider | Possible? | Mechanism | Auth |
|---|---|---|---|
| ~~Anthropic (Claude Pro/Max)~~ | EXCLUDED | Technically possible via `GET https://api.anthropic.com/api/oauth/usage`, but Anthropic does not allow subscription usage in third-party coding agents. **Do not build this adapter.** (Decision 2026-07-18.) | — |
| OpenAI Codex (ChatGPT plans) | Yes | ChatGPT backend `GET https://chatgpt.com/backend-api/wham/usage`. **Already implemented** in baked-in `narumiruna-pi-codex-usage` (query/normalize/format + 5min cache). | OAuth |
| Kimi coding plan | Yes | `GET https://api.kimi.com/coding/v1/usages` | API key (no OAuth) |
| Z.AI coding plan (GLM) | Yes | `GET https://api.z.ai/api/monitor/usage/quota/limit` (undocumented, used by official plugin) | API key |
| xAI Grok (SuperGrok/build) | Partial | OAuth state + `https://cli-chat-proxy.grok.com/v1/billing`; pay-as-you-go API has no quota endpoint | OAuth |
| Ollama Cloud | **No** | No usage API exists (open upstream requests). Web-scraping cookies is out of bounds. | — |

**Local servers:** Ollama `http://localhost:11434/v1` (models: `GET /api/tags` or `/v1/models`,
no key — pass dummy `"ollama"`; tool-calling on `/v1` can break streaming, test it). LM Studio
`http://localhost:1234/v1` (models: `GET /v1/models`, no key by default — dummy `"local"`).

---

## Phase 1 — Boot screen: remove sections, add skills counter, new art

Files: `interactive-mode.ts:732-749` (boot rows + hints), `boot-screen.ts`,
`boot-ascii.ts`, `interactive-mode.ts:1448-1527` (`showLoadedResources()`).

1. **Regenerate art**: rebuild `boot-ascii.ts` from the UPDATED repo-root `boot-ascii.md`
   (user replaced it). Same mechanical conversion as basics plan; never hand-edit the output.
2. **Remove hint + onboarding lines**: delete `compactInstructions` and `onboarding` and pass
   no footerLines (or delete the footerLines mechanism from `BootScreenComponent` if unused).
3. **Remove the auto-rendered [Context]/[Skills]/etc. sections at startup**: the
   `showLoadedResources()` listing (`interactive-mode.ts:1448-1527`) must not render into
   `loadedResourcesContainer` on boot. Keep the function for the expanded/verbose view
   (ctrl+o "more" flow) if one exists; if it's only called at startup, gate it behind
   `--verbose`.
4. **Skills counter**: add a boot row `{ label: "skills", value: String(skills.length) }`
   where `skills = this.session.resourceLoader.getSkills().skills` (`resource-loader.ts:266`).
   Only show when count > 0. (The details rows already sit next to the art; this adds one.)

Verify: `npx lunr` shows art + details (model, directory, session, config, theme, skills: N)
and nothing else — no hint line, no "Ask lunr…", no [Context]/[Skills] blocks.

---

## Phase 2 — Simplified subagent view

File: `builtin-extensions/pi-subagents/src/tui/render.ts` (`// lunr:` marked edits).

Current collapsed rows are built in `renderSingleCompact` (:1289-1323) and
`renderMultiCompact` (:1325-1420, per-row at :1392-1415). `r.task` (parent-entered task
string) is already on each result.

New per-agent row format (both single and multi):
```
<glyph> <task summary, truncated to ~60 chars> · <agent type> · <runtime> · <N tool uses> · <tokens>
```
- Task summary: first line of `r.task`, collapsed whitespace.
- Runtime/tool uses/tokens from `formatProgressStats(theme, rProg)` (already yields these) —
  reuse rather than reformatting.
- Running rows keep the `⎿ active now`-style activity line (dim).
- **Delete**: the `liveDetailHintText()` ("Press ctrl+o for live detail") lines (both render
  paths) and the `output:`/`artifactPaths`/`extractOutputTarget` lines.
- Header row (multi) stays as-is.

Verify: launch a 3-agent parallel run; rows show task/type/runtime/tools/tokens; no ctrl+o
hint, no output paths; completed + failed + pending states all render.

---

## Phase 3 — Dot-only status coloring + message dots

moon.json already neutralizes tool box backgrounds (`toolPendingBg/SuccessBg/ErrorBg` all
`nearBlack`). Remaining work is adding the dots.

1. **Helper** in `core/tools/render-utils.ts`:
   `toolStatusDot(state: "pending"|"success"|"error"): string` →
   `theme.fg("muted"|"success"|"error", "●")`.
2. **Generic component** `tool-execution.ts`: prepend the dot in `createCallFallback()`
   (:135) and `formatToolExecution()` (:365). Backgrounds: leave as-is (already neutral).
3. **Built-in tool renderers** (`core/tools/`: bash, read, write, edit, grep, find, ls):
   prepend the same dot in each `renderCall`/`renderResult` title line (e.g. `read.ts:76`).
   Pending state = running/partial; success/error from `result.isError`.
4. **Message blocks**: white ● on the first line of user and assistant messages.
   - `user-message.ts` `rebuild()`: prefix markdown text with `theme.fg("brightWhite", "● ")`.
   - `assistant-message.ts` `updateContent()`: prefix the FIRST text block's first line only
     (not every line, not thinking blocks). If markdown reflow eats the prefix, add the dot as
     a separate leading `Text` line — pick whichever survives rendering; note the choice.

Verify: bash call shows `● Ran a command` (gray while running, green on success, red on
error); user and assistant messages start with a white ●; everything else stays monochrome.

---

## Phase 4 — Session management

Recon facts: sessions are JSONL at `~/.lunr/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`;
`SessionManager.list()/listAll()` (:1549/:1564) build `SessionInfo[]` (name, created,
modified, messageCount, firstMessage); `/name` exists (`slash-commands.ts:27`,
`handleNameCommand` at `interactive-mode.ts:5538`); `AgentSession.setSessionName()`
(`agent-session.ts:2810`); no delete API in SessionManager (session-selector deletes files at
`session-selector.ts:645`); resume picker is `cli/session-picker.ts` +
`components/session-selector.ts`.

1. **`/title <name>`**: register as an alias sharing `handleNameCommand` (keep `/name`
   working). Add to `BUILTIN_SLASH_COMMANDS`.
2. **Auto-name**: after the FIRST assistant response completes in an unnamed session, generate
   a ≤6-word title from the first user message via a one-shot
   `this.session.modelRuntime.complete(...)` call (use the light tier model if plan-2 tiers
   are enabled, else the session model), then `setSessionName(...)`. Fire-and-forget; never
   block the turn; swallow errors (no title on failure). Skip if the user already named it.
3. **`/sessions`**: open the existing session selector in interactive mode (reuse
   `SessionSelectorComponent`; follow how `/tree` or resume wires selectors). Selecting a
   session resumes it (same path as `lunr --resume`).
4. **30-day cleanup at launch**: in `main.ts` startup (before TUI init), scan the sessions
   root; delete `.jsonl` files with mtime older than the retention setting. New setting
   `sessionRetentionDays` (default `30`, `0` = keep forever) in `settings-manager.ts` +
   a numeric row in `/settings`. Log deletions to the debug log only. Never delete the
   currently-active session file.

Verify: unnamed session auto-titles after turn 1; `/title foo` overrides; `/sessions` lists +
resumes; a touched-old dummy `.jsonl` is deleted on next launch; retention `0` disables.

---

## Phase 5 — /undo and /redo

Recon: no truncate API; append-only files; but `AgentSession.navigateTree(targetId, options)`
(`agent-session.ts:2832`, powers `/tree`) moves the in-memory leaf, and
`sessionManager.branch(id)`/`resetLeaf()` exist.

Design (in-session only, v1):
- `/undo`: find the entry id immediately BEFORE the last user message of the current branch;
  push the current leaf id onto an in-memory redo stack; `navigateTree` to that earlier id.
- `/redo`: pop the redo stack; `navigateTree` back. Empty stack → notify "nothing to redo".
- Any new user message clears the redo stack.
- State lives on InteractiveMode (not persisted). Known limitation to document in AGENTS.md:
  the JSONL file is append-only, so undone turns reappear after restart. Persistent undo =
  `createBranchedSession` to a new file — deferred.

Verify: 3-turn session → /undo shows 2 turns, /undo → 1, /redo ×2 restores; new message after
undo kills redo.

---

## Phase 6 — /usage command + subscription limit bar + cost-meter rules

### 6a. Usage service with per-provider adapters (new)

New core module `core/usage-service.ts` (+ `core/usage-adapters/*.ts`):
```ts
interface PlanUsageWindow { label: string; usedPercent: number; resetsAt?: number }
interface PlanUsage { provider: string; planLabel?: string; windows: PlanUsageWindow[] }
async function getPlanUsage(providerId, runtime): Promise<PlanUsage | undefined> // undefined = unsupported
```
Adapters (cache 5 min each, like codex-usage's `CACHE_TTL_MS`):
- **openai-codex**: reuse `narumiruna-pi-codex-usage`'s query path
  (`builtin-extensions/narumiruna-pi-codex-usage/src/query.ts` — import or extract; do NOT
  duplicate the app-server fallback, keep the HTTP path).
- **anthropic**: deliberately NO adapter. Anthropic prohibits subscription usage in
  third-party agents. Anthropic OAuth logins therefore hit the 6c fallback: cost meter hidden.
- **kimi-coding**: `GET https://api.kimi.com/coding/v1/usages` with the stored API key.
- **zai** (glm): `GET https://api.z.ai/api/monitor/usage/quota/limit` with API key.
- **xai**: OAuth token + `https://cli-chat-proxy.grok.com/v1/billing`; on failure → undefined.
- **ollama-cloud**: always undefined (no API exists). Adapter returns undefined immediately.

### 6b. /usage command (core)

`BUILTIN_SLASH_COMMANDS` + dispatch + `handleUsageCommand()`. Render a bordered box into the
chat (follow the settings/login selector patterns, or a plain multi-line `Text` block — box
drawing per this layout):

```
╭ Usage ───────────────────────────────────────────────╮
│ Session usage                                        │
│   kimi-coding/k3   input 24.3M  output 83k  24.4M    │
│ Context window                                       │
│   ████░░░░░░░░░░░░░░░░   19%  (193k / 1M)            │
│ Plan usage                                           │
│   Weekly   ███░░░░░░░░░░  14% used  resets in 6d 21h │
│   5h       ███████████░░  71% used  resets in 2h 51m │
╰──────────────────────────────────────────────────────╯
```
- Session rows: aggregate `sessionManager.getEntries()` by `provider/model`
  (input/output/total from `message.usage`).
- Context: `this.session.getContextUsage()` (`agent-session.ts:3111`).
- Plan section: `getPlanUsage(currentProvider)`. Unsupported/absent → omit the section
  entirely (not an error). Bars: 20-cell `█/░`, monochrome.

### 6c. Footer cost-meter rules

File: `builtin-extensions/ashxj-tui.ts` `renderStatsLine` (:507, cost at :541) — `// lunr:`
edit, coordinated with plan 2's goal-key edit to the same function.
- Current provider is OAuth/subscription (`modelRuntime.isUsingOAuth(provider)`) AND
  `getPlanUsage` returns data → replace the `$x.xxx` segment with a compact limit segment:
  `5h 71%·rst 2h51m` (shortest window only).
- OAuth/subscription but NO adapter data → drop the `$` segment entirely (user requirement:
  no dollar counter on untrackable subscriptions).
- API-key/pay-per-token → keep `$x.xxx` as today.
- Refresh: reuse the codex-usage pattern (refresh on model_select + 5-min cache; no new
  timers).

Verify: Codex OAuth session → footer shows limit segment; /usage box matches the layout with
real numbers; Kimi API-key login → plan section appears; ollama-cloud → no plan section, no
error; API-key openrouter → cost meter unchanged.

---

## Phase 7 — One-click local providers (Ollama, LM Studio)

Recon: login flow only iterates registered providers (`interactive-mode.ts:4763`); models.json
supports `baseUrl`/`api`/`apiKey`/`models`; `pi-ollama-cloud` shows the runtime
`/v1/models` fetch pattern (`pi-ollama-cloud/models.ts:178`).

New baked-in extension `builtin-extensions/lunr-local-providers/index.ts` (lunR-native, no
@ts-nocheck):
1. Registers two providers via `pi.registerProvider`:
   - `ollama-local`: baseUrl `http://localhost:11434/v1`, api `openai-completions`,
     apiKey `"ollama"` (dummy per docs/models.md), `refreshModels` → `GET /v1/models`
     (fallback `/api/tags`), offline server → empty list + provider shown as unavailable.
   - `lm-studio`: baseUrl `http://localhost:1234/v1`, apiKey `"local"`, `refreshModels` →
     `GET /v1/models`.
   - Model entries: id from server, sane defaults (contextWindow 32k unless the server says
     more, cost zeros, input ["text"]).
2. Login integration: with the dummy key preset, both providers appear in `/login`'s
   api_key list as already-configurable; selecting one runs the standard ambient/key flow.
   Add the one-click bit: if the probe succeeds at login selection, immediately save the
   dummy credential via `AuthStorage.modify(provider, ...)` + `modelRuntime.refresh()` +
   auto-select the first model (mirroring `completeProviderAuthentication`,
   `interactive-mode.ts:5001`). No user input asked.
3. If the probe fails at selection: notify "Ollama not detected on localhost:11434 — start it
   and retry."

Verify: with Ollama running, `/login` → pick Ollama (local) → instantly usable, `/model`
lists its models; server off → clear notice, no hang (3s probe timeout).

---

## Phase 8 — /context breakdown

New core command. Data (recon): no per-entry tokens except assistant `usage`;
`estimateContextTokens` (`compaction.ts:176`) + `estimateTokens` (chars/4 heuristic).

`handleContextCommand()`: estimate and render a bar breakdown box:
- system prompt (estimateTokens on the system message incl. project context files)
- tool definitions (estimate over serialized tool schemas)
- user messages / assistant text / thinking blocks (split by content type, estimated)
- free space vs `contextWindow`
Label every number as an estimate in the footer line of the box (`estimated, chars/4`).
Bars `█/░` like /usage; monochrome.

Verify: box totals match `getContextUsage()` within ~10%; renders after compaction too.

---

## Phase 9 — Todo compact display setting

Recon gap: no built-in todo panel was found; todo state renders through the todo tool's
render output. FIRST locate the actual todo renderer in this build (search `core/tools/`
and `builtin-extensions/` for todo render/`renderResult` showing the checklist) and confirm
what the user sees today.

Then: settings toggle `todoDisplay: "default" | "compact"` (settings-manager + /settings
row). Compact = the renderer shows only the current in-progress item
(`● <title>` + `n/m done`); default = full list. Apply at the todo tool's render site.

Verify: toggle flips rendering without a restart; compact shows exactly one item + counter.

---

## Phase 10 — ashxj-thinking bake-in

1. `git clone https://github.com/ashx-j/ashxj-thinking` into `extension-repos/` (reference
   only, gitignored) and inspect its source + deps.
2. Copy into `packages/coding-agent/src/builtin-extensions/ashxj-thinking.ts` (single-file,
   matching ashxj-tui/ashxj-spinners convention). Add `// @ts-nocheck` if upstream.
3. Register in `builtin-extensions/index.ts` (`ext("ashxj-thinking", ashxjThinking)`) —
   main.ts picks it up automatically.
4. Add any new deps to coding-agent's package.json (check imports first; prefer none).
5. Verify `/thinking` command appears and works; check it doesn't fight the moon theme or the
   thinking-block rendering (`hideThinkingBlock` setting) — if it renders its own colors,
   patch to theme tokens (`// lunr:`).

---

## Phase 11 — Plan mode: verify + auto-suggest

Recon: `narumiruna-pi-plan-mode` IS baked in and live: `/plan` command + `--plan` flag +
`plan_mode_question`/`plan_mode_complete` tools + edit/write/bash gating
(`plan-mode.ts:78-330`). So:

1. **Verify /plan works in lunR** end-to-end (enter, ask, finalize, implement, exit). Fix
   whatever's broken; check its widget doesn't clobber the ashxj-tui footer.
2. **Auto-activation**: do NOT build auto-detection heuristics. Add one paragraph to the
   system prompt (`core/system-prompt.ts`): when a task is complex/multi-file, the agent
   should propose a plan first and can enter plan mode via its tools before touching files.
   This makes auto-planning model-driven (matches how kimi-cli does it).
3. Document in AGENTS.md that /plan already existed (user-facing change is the auto-suggest).

---

## Phase 12 — Autocomplete [t] fix + extension settings into /settings

1. **[t] marker**: `interactive-mode.ts:491` `getAutocompleteSourceTag()` maps scope
   `temporary` → `t`. Baked-in extensions load as temporary. Fix: scope `temporary` returns
   no tag (they're part of lunR, not third-party). Keep `u`/`p` tags for user/project
   extensions.
2. **Extensions submenu in /settings** (core; extensions can't self-register rows):
   - "Memory character cap": numeric entry (1..30000, default 5000) bridging
     simple-pi-memory's `readCap/writeCap` (`simple-pi-memory.ts:68-78`). Bridge via a
     registered global (same Symbol pattern as plan-2 tiers) or move the config into
     SettingsManager and have the extension read it — prefer the latter: migrate storage
     from `~/.pi/simple-memory/config.json` to lunR settings, extension reads via the
     global. ALSO fixes one of the known hardcoded `~/.pi` paths.
   - "Search curator" toggle: bridges pi-web-access `/curator on|off`.
   - Keep `/memory-char-cap` and `/curator` as working aliases (no tag now), but the
     canonical UI is /settings.
3. Sweep: any other extension command that is purely a settings toggle gets a row; pure
   operations (fleet, doctor, stats) stay commands. List final mapping in AGENTS.md.

Verify: `/` autocomplete shows no `[t]`; memory cap editable in /settings and respected by
the extension across restarts; aliases still work.

---

## Cross-cutting verification

1. `npm run build` clean; `npx biome check packages/` clean.
2. `npm test` — no NEW failures beyond the recorded baseline (incl. the 89 vitest
   `Class extends value undefined` load failures from the bake-in cycle — pre-existing,
   separate fix).
3. Manual pass on Windows Terminal: boot screen, subagent run, tool dots, /usage box,
   /context box, /sessions, /undo/redo, local Ollama connect (if installed), /thinking,
   /plan.
4. Update `AGENTS.md` Current State: all 14 items, decisions, every `// lunr:` upstream
   edit, known limitations (undo non-persistent, Ollama Cloud untrackable, /context is
   estimated, Ollama /v1 tool-calling quirk).

## Definition of done

- 12 commits on `feat/lunr-ux`, one per phase.
- Each phase's verify steps pass.
- AGENTS.md Current State updated.

## Deferred / out of scope

- Persistent undo across restarts (needs `createBranchedSession` rewrite).
- Ollama Cloud usage (no API exists upstream).
- Grok pay-as-you-go API usage (no quota endpoint; OAuth subscription only).
- Hard heuristic auto-plan-mode (model-driven via system prompt instead).
- pi.dev telemetry/URL rebranding (carried over from plan 1 deferrals).
