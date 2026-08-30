# lunR

Custom CLI coding agent derived from pi. Builtin theme: `moon`. Roadmap: TUI ✓ features ✓ cron ✓ gateway ✓ (Discord/Telegram).

## Layout

lunR IS the git root. `pi/`, `hermes-agent/`, `kimi-cli/`, `extension-repos/` are gitignored study material — never import.

```
packages/tui · packages/ai · packages/agent · packages/coding-agent (bin lunr → dist/cli.js) · packages/orchestrator
```

## Toolchain

TypeScript ESM. Build order: tui → ai → agent → coding-agent → orchestrator (`npx tsgo -p <pkg>/tsconfig.build.json`). **Never `npm run build` in `packages/ai`** (generate-models catalog drift). Lint: `biome check packages/` (excludes `builtin-extensions/` + `*.generated.ts`). Tests: `vitest --run` (coding-agent), `node --test` (tui). Themes: JSON in `coding-agent/src/modes/interactive/theme/`.

## Agent rules

Read this file first; ask when ambiguous; touch only the task; small why-commits. No drive-by rewrites; check existing deps before adding. Never commit secrets; never force-push shared branches; confirm destructive git. Branch + PR before merge. Public docs: no local setup/secrets. Whenever an agent-facing tool is added, removed, renamed, conditionally registered, or materially changes purpose, keep its structured description/schema and conditional result guidance accurate, update tool-coverage tests, and regenerate the system-prompt inventory/snapshot when affected. Add always-injected base-prompt guidance only when the model needs it before its first tool call. **This file is the source of truth — after work update Current State + build/test, append Decisions (one-line why), gotchas under Notes. Delete stale entries. Committed detail lives in git log.**

---

# Current State

Last updated: 2026-08-30 (v0.2.13 shipped). Public npm is `@ashx-j/lunr@0.2.13` (tag `v0.2.13` = `8e1f0fc`). **NEVER MERGE `archive/extension-absorption-DO-NOT-MERGE`.** Untracked locals: `prompts/`, `DESIGN.md`, `LUNR_SYSTEM_INJECTION.md`, `lunR-checklist.md`, `.pi-subagents/`.

- **Settings menu copy (`fix/settings-menu-copy`):** `/settings` and its submenus use short feature summaries instead of implementation inventories. Details that affect a choice stay beside that choice or confirmation. The Rollback row is `Rollback behavior options`.
- **Skill tag character (`feat/skill-tag-character`):** `/settings` Skill tag sits next to Skill commands and is `+`, `~`, or `$` (default `+`). After a space or at the start of a line that character lists loaded skills like `/` at the start of the TUI. Completing inserts `{char}{name}`; send does not expand SKILL.md. `xyz+` does not open the picker; `~/` stays path completion when the tag is `~`. Independent of `enableSkillCommands`. Tests: skill-tag-autocomplete + settings-manager + interactive-mode-status trigger merge.
- **Agent memory + global instructions (`feat/agent-memory-agents-md`):** `~/.lunr/simple-memory/memory.md` is agent-managed durable facts only. `/settings` has a global Agent memory toggle beside the cap; off removes prompt injection and `memory_add`/`memory_remove`/`memory_load` without deleting data. Direct file-tool writes are blocked. Behavior presets and runtime `behavior.md` injection are removed; optional global behavior comes from a user-created, user-only `~/.lunr/agent/AGENTS.md` through the normal context loader and `/reload`. Migration removes only stale `behaviorPreset` settings. Tests: agent-memory + memory-cap + dynamic-tools + permissions + migrations + system-prompt + deferred roster.
- **Global context label (`fix/global-agents-context-label`):** `/context` and `/usage` label `~/.lunr/agent/AGENTS.md` as `Global AGENTS.md`; project instruction files remain `AGENTS.md`. The prompt path/content is unchanged. Test: context-breakdown.
- **Codex Fast + usage cleanup (`feat/codex-fast-usage-cleanup`):** `/fast [on|off|status]` persists `service_tier: "fast"` for `openai-codex` subscriptions only and marks the model chip. `/usage` fetches every stored-credential adapter plan plus the current env-only provider in parallel; Codex includes additional rate limits. The `/research` pipeline is removed; web tools and generic research subagents remain.
- **Watchdog cold start (`fix/watchdog-cold-start`):** the default-off main watchdog performs no repo-signature work during construction, session binding, or disabled turns. Enabled repo-edit review lazily establishes its baseline at `before_agent_start`; session and disable boundaries clear the old baseline. Tests: subagent-watchdog-startup + subagent/deferred regression set.
- **Shipped npm docs (`docs/lunr-user-facing`):** `packages/coding-agent` README/docs/examples/CHANGELOG now describe `@ashx-j/lunr`, binary `lunr`, `~/.lunr/agent` + project `.lunr/`. Catalog refresh is `/refresh`; `lunr update` only reinstalls the global CLI. Builtin theme is `moon`. Dropped stale `files` entry `containerization.md`. ExtensionAPI `pi` parameter, package.json `"pi"` key, and `PI_*` env names stay. Untracked `lunr-docs/` is not shipped.

- **Prompt-driven subagents (`feat/prompt-driven-subagents`):** no named agent types. Every child is `{ task, description, permissions? }`. `description` is required UI metadata (single-line, max 80). `permissions` is `full` or `read-only`; omitted means full. Full is child-safe coding tools (read/search/shell/edit/write/web/LSP/MCP) minus cron/memory/goals/plan-approval/nested subagents. Plan parents may launch only explicit `permissions: "read-only"`. Full maps to child Auto; read-only maps to child Plan. Named markdown, the legacy discovery/serializer/memory source cluster, agent CRUD/profile commands, provider profiles, and saved named chains are removed; `/run`, `/chain`, `/parallel`, and prompt workflows now build generic children. Foreground and async paths use `ChildSpec`; private `childId` drives routing while descriptions drive UI. Lifecycle artifact version 3; old runs cannot be resumed. Scheduled singles and appended async steps use the generic contract. Tests: prompt-driven-subagents + subagent-permission-inherit + subagent-compact-row + permissions/control/parallel fixtures.

- **Same-turn swarm + leftover gates (`0.2.11`):** 3+ SINGLE `subagent` calls in one assistant turn count as a swarm (one prompt / one reject covers the message). Same-turn SINGLEs overlap (`executionMode: "parallel"`); sequential work stays `chain`. Gateway `/new` aborts the live turn and drops the queue. TUI cron uses the same deliver allowlist as the gateway. Corrupt models-store JSON is treated as empty. Plan-mode git walk skips known globals. Manual mode prompts for apply-mode `code_rewrite`. Tests: permissions + plan-mode + models-store + gateway-cron + gateway-router + gateway-agent-bridge.

- **System-injection review artifacts:** root `LUNR_SYSTEM_INJECTION.md` and `LUNR_SYSTEM_PROMPT_DRAFT.md` are local review artifacts, not runtime prompt sources. Regenerate the effective snapshot after this branch before treating it as current.
- **lunR base system prompt (`feat/lunr-system-prompt`):** default prompt now identifies lunR and the active `provider/model`, injects runtime cwd/documentation paths, and uses the approved behavior/guideline text. API tool definitions and extension prompt metadata are not duplicated in it. Model switches rebuild the prompt; custom `SYSTEM.md`, append/context/skill injection, and conditional extension addenda remain unchanged.
- **Image paste chips:** clipboard paste inserts atomic `[image_1]` / `[image_2]` instead of a temp path. Submit keeps the labels in the chat card and attaches `ImageContent`. `/edit` restores chips + files. Tests: tui editor image chips + image-paste-markers + startup-input.

- **TUI bugs (`fix/tui-bugs`):** scrollbar thumb drags (capture + last-column hit) and resets SGR so error/thinking colors do not bleed. Left-drag does not select or copy; Shift+drag stays native. `/undo` rewinds the same session (no fork, no editor paste); `/edit` is the same rewind then pastes; `/redo` works. Live thinking is a 4-line max tail of the latest rendered text (full string, not the typewriter prefix; no empty-row pad). Compact running subagent rows hang tool/token/time stats (no thinking text). TUI hides `⚠ Subagent needs attention` cards (`display: false`, no `triggerTurn`). Tests: tui-pin + mouse + thinking-tail + assistant-message + undo-edit + slash-commands + compact-row + control-notice.
- **Subagent TUI + parallel (`fix/subagent-tui-and-parallel`):** compact-row glyph seeds only the row index (not tokens/duration/lastActivityAt). Compact hang line is tools · tokens · time. Footer swarm is `swarm` (no `● active`). Working row no longer prefixes `Orchestrating…`. Customize → Footer: TPS counter (`footerTps`, default on) is independent of feature statuses. Default parallel concurrency / maxTasks / global run cap are unlimited (explicit `concurrency` still honored). Same-name tree chrome appears while tools are still running (`tree` ≠ `!isPartial`). Live thinking does not pad empty rows to 4. Tests: compact-row + ashxj-spinners-orchestrating + settings-manager footerTps + subagent-parallel-concurrency + format-grouped-call + tool-execution-component + thinking-tail + assistant-message.
- **Open UX notes (`fix/open-ux-notes`):** `present_plan` appends a full Plan chat card then a short Approve/Decline dock. Footer active goal is `goal`. `/usage` is this-session context (no Last 30 days); `/token-usage` removed. Completed todos prune on the next user turn (no `✓ N done`). Pinned chat has a 1-col scrollbar. `/goal` forces session auto. Compact subagent rows show model + thinking. `subagent models` result is hidden. Goal complete is one agent message. Tests: usage-view + context-breakdown + lunr-todos + compact-row + permission-mode-control + plan-message + tui-pin + mouse.
- **Tool view (`fix/tool-view-fixes`):** collapsed reads are basename-only. Search/fetch fold the count into the header; `ctrl+o` lists queries or URLs. Consecutive same-name cards collapse facing box pad + top spacer only; singletons and mixed neighbors keep `Box(1,1)`. PowerShell clipboard fallback uses `-STA`. Tests: render-search-chrome + tool-execution-component + clipboard-image + tui keys + box.
- **VS Code Alt+V image paste:** no toast meant VS Code ate `alt+v` (View mnemonic / host key). Image paste is still `app.clipboard.pasteImage` (`alt+v` on win32). Forward with VS Code `sendSequence` `\u001b[118;3u`. lunR also matches leaked legacy `ESC v` while Kitty is on. Tests: tui keys Alt+V CSI-u + leaked ESC+v.
- **Smooth streaming (`fix/smooth-streaming-review`):** interactive TUI typewriter (`settings.smoothStreaming`, default off). Per-block append-only grapheme cache (providers mutate `block.text` in place). Always paint after reveal ticks (~30 FPS, no extra 33ms gate). Mid-stream toggle applies immediately without rewind. Hide-thinking re-slices instead of dumping the tail. Stop timer when caught up. Hidden thinking excluded from budget. Tool cards gated on reveal frontier (flush on `tool_execution_start`). Catch-up step capped. Settings copy matches grapheme/~30 FPS. Tests: `smooth-streaming.test.ts`. Print/RPC/gateway stay unsmoothed.
- **Same-tool spacing (`fix/same-tool-spacing`):** consecutive same-name cards collapse facing box pad + top spacer only. Singletons and mixed neighbors keep `Box(1,1)`. Tests: box + tool-execution-component density.
- **Same-tool stack all (`fix/same-tool-stack-all-tools`):** collapsed finished success is header-only for every default-shell tool (not just `read`). Grep/find/ls notices and MCP/todo bodies wait for `ctrl+o`. Search/fetch count folds into the header. `edit` (`renderShell: "self"`) honors continuation/followed pad. Fallback `contentText` gets the same facing pad. Subagent compact widgets stay. Tests: tool-execution-component density + render-search-chrome + tui text pad.
- **Same-tool tree (`fix/same-tool-tree-chrome`):** a consecutive same-name compact run prints the verb once, then hangs details off `├─` / `└─`. Singletons stay `● read file`. Still-running grouped cards use the same tree (`tree` ≠ `compact`/`!isPartial`). Collapsed errors stay in that tree; mid-group error bodies hoist under the last leaf. Tests: format-grouped-call + tool-execution-component density.
- **Pinned scroll layout (`fix/pinned-chat-scroll-lag`):** wheel/page/thumb reuse cached chat lines; overflow gutter is sticky; `setChatScroll` does not sync-layout. Tests: tui-pin render-count + gutter sticky.
- **Thinking aliases:** `/thinking` picker copy has no fake token budgets. `/effort` and `/reasoning` are full-parity aliases of `/thinking` (TUI extension + gateway). Tests: ashxj-thinking + gateway-commands.
- **Thinking chatbox levels (`fix/thinking-chatbox-levels`):** chip prints the effective level including `xhigh`/`max`; box border uses `this.borderColor` (thinking tokens). `/thinking` matches `getSupportedThinkingLevels` (xhigh/max opt-in). Moon `thinkingMax` is `lunrBlue` (not `brightWhite`; `accent` is already `brightWhite`). Tests: ashxj-thinking + ashxj-tui-chip + max-thinking.
- **xAI grok-4.6 xhigh (`fix/xai-grok46-xhigh-catalog`):** generator stamps `thinkingLevelMap.xhigh` on grok-4.6+ (versioned, not a frozen id). grok-4.5 stays without native xhigh. Contract tests: `xai-thinking.test.ts` (baked-in 4.5 + `catalog/providers/xai.json`).
- **Grok 4.6 xhigh at runtime (`fix/grok46-xhigh-runtime`):** `mergeCatalogLayers` applies `withXaiEffortMetadata` so a stale cache/live template cannot hide xhigh. `/refresh` rebinds the session model; `/thinking` reads the registry row. Tests: xai-thinking + model-refresh-merge.
- **xAI grok-4.5+ Responses:** generator + `withXaiEffortMetadata` use `shouldUseXaiResponsesApi` (`parseXaiGrok4Minor >= 5`), not a frozen `grok-4.5` id. Completions exceptions go in `XAI_RESPONSES_EXCLUDED_MODEL_IDS`. Completions compat must not leak onto Responses (`supportsDeveloperRole: false` would drop the developer system role). Tests: xai-thinking + xai-responses + model-refresh-merge.
- **OpenCode Zen free models (`feat/opencode-zen-free-models`):** generator intersects `GET https://opencode.ai/zen/v1/models` (and `/zen/go/v1/models`) with models.dev — keep deprecated-if-live, drop not-on-live, synthesize live ids missing from models.dev. Do not add a second Zen provider; `/model` still needs `/login opencode`. Tests: `opencode-catalog.test.ts`.
- **Product UX (`feat/lunr-product-ux`):** tab title is `lunr` (OSC 0 + `process.title` before main import; ashxj-spinners no longer `setTitle("ashxj")`). Advertised subagents are always fresh (`lunr-child-context.ts`; fork internals stay). Model tiers have per-tier thinking (unset = parent session). `lunr update` + 24h npm check of `@ashx-j/lunr` (workspace npx skips). Footer shows git branch + `+/-` vs HEAD and a compact plan bar (5h preferred falls back to weekly; 60s cache). Customize → Footer: plan usage hides the segment; Footer: plan bar hides only the █░ fill and keeps the percent. Click a ✻ Thought or tool card to expand/collapse that item; `app.tools.expand` is unbound (tree `ctrl+o` stays). Tests: lunr-tab-title + lunr-child-context + model-tiers + update-check + footer-data-provider + usage-service pickPlanWindow + tui mouse click + assistant-message handleClick + lunr-todos.
- **Planned mascot - cat (2.A):** TUI cat fits kitty spinners `₍^. .^₎⟆` / `(ㅅ´ ˘ `)`. Minimal 2-line. Not yet wired.
  ```
     /\_/\
    ( ˃ᴗ˂ )
  ```

## On origin/master (`a698e57`)

- **Catalog (pi-style):** `generate-models.ts --strict --json-only` → `.artifacts/model-catalog`; `scripts/sync-model-catalog.mjs` validates (≥500 models; require anthropic/openai/openrouter) → `catalog/` (`models.json` minified, `providers.json`, `providers/{id}.json`, `publication.json`). CDN = GitHub raw `master/catalog/`. `/refresh` GETs `providers.json` (4s) then shards only for **stored-cred** providers (4s; skip 404). Fallback: `~/.lunr/agent/official-catalog-cache.json` → bundled `catalog/` (`copy-assets` → `dist/catalog/`). Merge: official > user-models > live `/models` > baked-in `*.models.ts`. New live ids can prompt (cap 8); official id evicts user row. Humans edit the **generator**, not the JSON. CI `.github/workflows/publish-model-catalog.yml` every 4h + dispatch. `npm run sync:model-catalog`. No R2, no `pi.dev`. `catalog/official-models.json` gone.
- **`/refresh` OAuth:** live list calls `getAuth` before `GET /models` so expired SuperGrok tokens refresh (`ec59883` / PR #4). Toast reports only attempted providers and includes `error`. Remap to `xai login expired (run /login xai)` only on `invalid_grant` / revoked refresh, not a timeout or generic OAuth error. Tests: catalog-auth + catalog-merge.
- **xAI SuperGrok + Grok CLI:** same OAuth client as official `grok`. xAI rotates refresh tokens and revokes the family on reuse. lunR keeps its own live rotation when Grok still has the previous family; adopts `~/.grok/auth.json` only when lunR is expired or after `invalid_grant`. Write-through uses RFC3339 `expires_at`, refuses to overwrite a newer Grok family, and does not treat `modify(undefined)` as adopt. `/login xai` can import the Grok CLI session. `/logout xai` does not delete `~/.grok/auth.json`. `/usage` remaps only 401 billing + `invalid_grant` to `xAI login expired. Run /login xai.` Tests: grok-cli-auth + catalog-auth + usage-service.
- **`/model` listing:** stored cred only (`auth.json` / subscriptions / `--api-key`). Ambient `OPENROUTER_API_KEY` does not list models. `getAuth`/stream still resolve env if a model is already selected. Logout deletes that provider’s `models-store` + user-models. Tests: catalog-auth.
- **`create()` cache-only:** `refresh({ allowNetwork: false })`. No GitHub / provider lists at `ModelRuntime.create()`. `withRemoteCatalog` deleted.
- **Cold start:** TUI init/footer uses `refreshModelCandidatesForInit` (cache-only). Official overlay on every stored-cred provider. Shard-merge cache (failed shard keeps old rows). `refresh()` is single-flight and keeps in-memory GitHub rows. Offline `/refresh` skips Ollama Cloud. Cloud `session_start` is cache-only. Local Ollama/LM Studio probes skip on `allowNetwork: false` and use `127.0.0.1`. xAI token refresh hard-caps at 30s (4s aborted after xAI had already rotated). Auth.json lock stale is 120s; writes are tmp+rename. `lunr gateway` lazy-imports discord.js. fd/rg download is background. V8 compile cache at `~/.lunr/agent/compile-cache`. `PI_TIMING=1` labels `import:main` (survives `resetTimings`) plus ModelRuntime/resourceLoader/TUI init; interactive `printTimings()` runs after `init()` (time-to-type), not before `run()`. Interactive first paint loads `lightBuiltinExtensions` only (no ollama-cloud / goal / cron). MCP / LSP / web-access / intercom / subagents / prompt-template / cron / goal / ollama-cloud attach after `ui.start()` in the background; `init()` / `getUserInput()` do not wait. Every `session.prompt` / `sendUserMessage` and `/new` wait for attach. Print / RPC / gateway still `loadAllBuiltinExtensions()` before the first turn. `--api-key` is cache-only at create. Initial interactive `resourceLoader.reload` skips missing npm/git auto-install; later reload / print / RPC still install. `git fetch` and `npm root -g` time out (10s); `PACKAGE_INSTALL_TIMEOUT_MS` stays 30s. Cache-only official catalog prefers `official-catalog-cache.json` and skips bundled `models.json` parse when the cache exists. Node loader lazy-imports jiti / `providers/all` / the public barrel; Bun `host-static.ts` keeps those static. Both `@earendil-works/*` and `@ashx-j/lunr*` aliases exist. Non-TTY stdin no longer waits forever (`readPipedStdin` first-chunk timeout; deprecation keypress skipped). Tests: model-runtime-startup + official-catalog + catalog-auth + lunr-local-providers + xai-oauth + deferred-builtin-extensions + startup-hang-followup.
- **Also on master (see git log):** sticky chatbox + plan-as-permission-mode + xAI weekly `/usage` + traffic-light bars (`3a8d843`); TUI batch + cache hit-rate (`3cf89f9`); npm-audit workflow manual-only (`8266ede`).
- **Model-tiers toggle:** `/settings` Enable model tiers used `pi.runtime.refreshTools()`; `pi` is `ExtensionAPI` and has no `runtime`. Fix: `pi.registerTool(tool)` + bridge swallows refresher throws. Tests: `model-tiers.test.ts`.
- **Session wheel:** sticky chat + alt-screen has no native scrollback. TUI enables SGR 1000+1006 while pinned; wheel → `scrollChat` (±3, Ctrl+wheel pages). Shift+drag still selects. Tests: `mouse.test.ts` + `tui-pin.test.ts`.
- **Child permission inherit:** parent snapshots `PI_SUBAGENT_CHILD_PERMISSION` (`full` | `read-only`) at spawn. Child `PI_SUBAGENT_CHILD=1` maps full→auto and read-only→plan in `main.ts` before tools. Plan parent rejects full/omitted launches (`PLAN_MODE_WRITE_SPAWN_ERROR` tells the model to relaunch with `permissions: "read-only"`). Non-child `lunr -p` stays fail-closed. Tests: `subagent-permission-inherit.test.ts` + permissions fail-closed.

## Installer

- **Install:** `npm i -g @ashx-j/lunr` (Node ≥ 22.19). Current published: **0.2.13**.
- Workspace names stay `@earendil-works/pi-*`. `scripts/publish.mjs` rewrites **package.json and compiled JS/d.ts imports** to `@ashx-j/lunr{,-ai,-tui,-agent}`. Rewriting names only is not enough — `0.1.0` crashed with `Cannot find package '@earendil-works/pi-ai'`.
- CI: `.github/workflows/publish-npm.yml` on `v*` + `secrets.NPM_TOKEN`. Never publish `@earendil-works/*`.

## Not merged

- None for 0.2.13.

## Uncommitted (working tree)

- None for 0.2.13.

## Build & run

- Compile ai with `npx tsgo -p packages/ai/tsconfig.build.json` (offline). Then agent → coding-agent → orchestrator.
- JSON catalog: `npm run sync:model-catalog` (needs network). Do not hook generate into root `npm run build`.
- `npx lunr --version` / published CLI → **0.2.13**. **Rebuild tui then coding-agent `dist` after merge** or features look missing.
- Commits often `--no-verify` (`check:pinned-deps` vs unpinned `^`).
- `npx lunr --print` does not self-exit here — wrap with `timeout`.
- From this repo, `npx lunr` is the workspace bin (`packages/coding-agent/dist/cli.js`), not `%AppData%\Roaming\npm\lunr`. Rebuild coding-agent `dist` first. Time first paint with `PI_STARTUP_BENCHMARK=1 PI_TIMING=1 npx lunr` (stays interactive without a TTY and exits after attach). Add `-ne` to skip deferred factories. That is not a published-npm smoke test.
- Smooth streaming unit tests: `npx vitest --run test/smooth-streaming.test.ts` from `packages/coding-agent` (10 tests as of 2026-08-18).
- Watchdog cold-start verification (2026-08-28): full tsgo sequence passed; focused Vitest 25/25; touched-file Biome passed (watchdog source remains excluded); dirty-worktree benchmark prompt-ready 2.23s, deferred attach 265ms, subagent factory 6ms. Full coding-agent Vitest: 2236 passed / 125 unrelated current-master Windows failures. Full Biome: 35 pre-existing errors + 1 warning outside touched files.
- Watchdog PR CI caveat: the workflow still runs the forbidden `npm run build` in `packages/ai`; live catalog generation currently produces a Cloudflare transport TS2353 before reaching this patch. The explicit offline tsgo sequence above is green.
- lunR system prompt (2026-08-29): coding-agent `tsgo` passes; focused prompt/tool/model tests pass (29/29). Expanded run passes the new SDK prompt assertion but retains two unrelated Windows path failures; full suite remains red from pre-existing environment/working-tree failures.
- Published npm docs are `packages/coding-agent/{README.md,docs/**,examples/**,CHANGELOG.md}` (packed via `package.json` `files`). Repo-root README and untracked `lunr-docs/` are not what npmjs shows. `npm pack --dry-run --ignore-scripts --json --workspace=@earendil-works/pi-coding-agent` lists them.
- Prompt-driven subagents (2026-08-29): coding-agent build/copy-assets passes; focused 13-file Vitest run passes 172/172; `npx lunr --version` is 0.2.11, a rebuilt print message returned `smoke-ok`, and an end-to-end generic `{ description: "Verify generic child smoke", permissions: "read-only" }` launch returned `child-smoke-ok`. Full coding-agent Vitest remains red with 2261 passed / 114 unrelated current-master Windows/fixture failures / 47 skipped. Full Biome remains red with 37 pre-existing errors + 1 warning outside the touched extension/test files.
- Codex Fast + usage cleanup (2026-08-29): tui → ai → agent → coding-agent tsgo passes. Focused Vitest passes AI 66/66, agent 19/19, coding-agent 139/139, plus the Fast settings persistence test 1/1. The full settings-manager file retains 5 unrelated Windows `.pi` fixture failures; its new test passes. Biome passes 22 changed files; aggregate touched-file lint still reports pre-existing formatting/import-order errors in high-conflict files.
- Agent memory + global instructions (2026-08-29): required tui → ai → agent → coding-agent → orchestrator offline tsgo sequence passes. Focused coding-agent Vitest passes 73/73. Adding resource-loader coverage passes 90/96; its 6 existing Windows `.pi`/symlink fixture failures remain unrelated, while global `AGENTS.md` discovery passes. Touched-file Biome retains pre-existing format/import-order findings in hot files; new memory implementation/test files pass separately.
- Global context label (2026-08-30): coding-agent tsgo passes; focused context/usage Vitest passes 15/15. Biome passes the changed core/test files; `interactive-mode.ts` retains its pre-existing import-order finding.
- Skill tag character (2026-08-30): coding-agent tsgo passes. Focused Vitest: skill-tag-autocomplete 11/11, settings-manager skill-tag 2/2, interactive-mode wiring/trigger-merge 4/4. New files pass Biome; `settings-selector.ts` keeps its pre-existing format finding and `interactive-mode.ts` its pre-existing import-order finding.
- Settings menu copy (2026-08-30): coding-agent tsgo, settings-selector Biome, and `git diff --check` pass. Focused Vitest passes 49/52; the three unrelated existing Windows failures are in rollback memory-path coverage and settings-manager external-edit fixtures, while model-tiers and memory-cap pass. The pre-commit aggregate check retains the documented pinned-dependency failures from study material and coding-agent dependencies.

---

# Architecture

- **Features = baked-in extensions + bridges.** `builtin-extensions/` (inline factories in main.ts; hidden; vendored `// @ts-nocheck`; biome-excluded). Light roster: simple-pi-memory, pi-tps, ashxj-tui, ashxj-spinners, ashxj-thinking, lunr-local-providers, lunr-todos, lunr-plan-tools, lunr-skill-creator. Deferred (interactive after paint; print/RPC/gateway before first turn): pi-ollama-cloud, narumiruna-pi-goal, lunr-cron, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, pi-lsp-extension, pi-mcp-adapter. Removed: lunr-behavior, context-mode, MattDevy + narumiruna collections.
- **Bridges:** `globalThis[Symbol.for("@lunr/...")]`. Never runtime-barrel-import `@earendil-works/pi-coding-agent` under `builtin-extensions/` — concrete modules only. `complete`/`streamSimple`/`getModel` from `@earendil-works/pi-ai/compat`.
- **Cron:** `core/cron` in TUI (live session) and gateway (fresh headless session). One `jobs.json` `~/.lunr/agent/cron/`. `runWithOrigin` ALS. Gateway fallback: `cronFallbackModels`.
- **Gateway:** Telegram long-poll + Discord (mention-gated, no GuildMembers intent). Authz fail-closed. `ADAPTER_FACTORIES`.
- **Footer:** ashxj-tui `setFooter` only. Toggles are render-time `CustomizeBridge` reads.
- **Permissions:** `manual | yolo | plan | auto`; Shift+Tab cycles that order. Plan = `gateToolCall` + `PLAN_MODE_ADDENDUM`. Fail-closed without handler. Swarm (>2 parallel in one `tasks`/`chain.parallel` call, or that many same-turn SINGLE `subagent` calls) gated in manual AND yolo.
- **Rollback:** per-turn snapshots; `/rollback` forks and restores files. `/undo` and `/edit` stay in the same session via `navigateTree` (no fork).

# Renamed vs still "pi"

Renamed: bin `lunr`, `.lunr/`, `APP_NAME`. **Never write `~/.pi/`.** Still pi: `@earendil-works/pi-*` scopes, `PI_CODING_AGENT*` env, `getPiUserAgent`, `/share` default `https://pi.dev/session/`.

# Notes

- Theme: `moon.json` is the builtin; `default.json` untracked/unwired. Glyphs `promptMoon`/`promptArrow`; `promptSymbol` is master on/off.
- Mouse tracking is on while the chat dock is pinned. Left-drag does nothing; click expands/collapses a thinking run or tool card; Shift+drag is native terminal selection; wheel without Shift scrolls the session. Scrollbar last-column press/motion drags the thumb.
- Selectors: keybinding layer (`tui.select.cancel`), never raw `\x1b` (Kitty CSI-u).
- Win32: Ctrl+V is the terminal’s; image paste is `Alt+V`. Paste inserts `[image_n]` chips, not a temp path. Do not expand those chips back to paths on submit.
- Process registry: direct children only; `nohup &` grandchildren untracked.
- vite/oxc: `import type { A, B }` not `import type { A, type B }`.
- Telegram length = `string.length` (UTF-16). Busy-session `/stop` `/new` must bypass session guard.
- `// lunr:` = upstream edit markers. Hot sync files: `ashxj-tui.ts`, `interactive-mode.ts`, `agent-session.ts`, `bash.ts`, `settings-manager.ts`, `main.ts`, `builtin-extensions/*`.
- Injected-prompt collapse is render-only (`[SWARM MODE]` / `[DEEP RESEARCH]` / goal marker).
- `LUNR_SYSTEM_INJECTION.md` is a point-in-time effective-prompt snapshot, not an input. Regenerate it after changes to `system-prompt.ts`, active tools/extensions, `AGENTS.md`, skills, permission mode, goal state, `~/.lunr/simple-memory/memory.md`, or `~/.lunr/agent/AGENTS.md`.
- Tool schemas are the always-available discovery layer. Keep recovery/workflow instructions conditional in tool results where possible; reserve base-prompt rules for guidance required before the first call.
- `/plan <task>`: enter plan + send; if already in plan, restore previous mode + send.
- Catalog: `models.json` is one minified line on purpose; `/refresh` does not download it (shards only). Cache-only create prefers `official-catalog-cache.json` over parsing bundled `models.json`.
- Shipped user docs live in `packages/coding-agent` (README + `docs/` + `examples/`). Author markdown for `@ashx-j/lunr` / `lunr` / `~/.lunr/`. Keep ExtensionAPI `pi`, package.json `"pi"`, and `PI_*` env names. Do not treat repo-root README or untracked `lunr-docs/` as the npm page.
- Repo `npx lunr` is the workspace bin, not `%AppData%\Roaming\npm\lunr` (`@ashx-j/lunr`). Do not treat local npx as a published smoke test.
- **Stop proposing boot-screen art.** Slim box only; ask first.
- Smooth streaming is interactive-TUI only (`smooth-streaming.ts` + timer in `interactive-mode.ts`). I keep segment state on content-block objects, not the shallow-copied AssistantMessage, because providers append into the same block instances.
- Pinned chat scroll reuses the last chat layout; do not re-layout on offset. Overflow gutter is sticky so we do not probe full width every frame.
- Collapsed same-name tool rows are header-only; click the card to reveal bodies/notices. Subagent compact widgets are the exception. Collapsed grouped errors stay in the tree and print under the last leaf. `app.tools.expand` has no default key; `/tree` still uses `ctrl+o` to cycle filters.
- Global behavior is optional `~/.lunr/agent/AGENTS.md`: never auto-create it, add an in-app editor, or let model file tools modify it. `behavior.md` is retired and inert. Memory is durable facts only; off removes injection/tools but preserves the file, and direct file edits stay blocked.
- Context breakdown labels the resolved user-level instruction path as `Global AGENTS.md`; do not relabel project `AGENTS.md` files or alter the injected prompt path.
- Skill tag is a mention in the user text (`+pdf-tools`). Do not expand it into a `<skill>` block; `/skill:name` remains the force-load path. Open the picker only at a token start (start of line or whitespace before the character). When the tag character is `~`, `~/` and `~\` stay file paths.
- Tab title: `process.title` + OSC 0 `lunr` in `cli.ts` before importing main; InteractiveMode then sets `lunr - [session -] cwd`. Do not call `ctx.ui.setTitle` from ashxj-spinners.
- Advertised children always start fresh. `fork-context.ts` stays for upstream sync; do not advertise `context: fork` in the tool schema/description. There are no named agent types; prompt children with `task` + `description` + optional `permissions`.
- Child `permissions: "full"` is not parent-equivalent. It includes coding tools (read/search/shell/edit/write/web/LSP/MCP) and excludes cron, memory_*, goals, present_plan, and nested `subagent` (unless fanout-authorized). Read-only omits edit/write/code_rewrite and runs as Plan.
- Compact subagent rows are description-first. Do not restore model-first `compactRowLead`. Never display worker/scout/reviewer role names.
- `description` is presentation only. Persist and route intercom/resume/steer by private `childId`; dynamic fanout suffixes it per item, and appended async steps require a fresh append namespace so they cannot collide with existing children.
- `lunr update` is npm global `@ashx-j/lunr` only. Workspace `PACKAGE_NAME !== NPM_CLI_PACKAGE` skips the nag and refuses to self-update.
- Plan footer uses a 60s usage cache. Preferred window is `/settings` Plan usage window (`5h` | `weekly`); missing 5h falls back to weekly. Customize → Footer: plan usage hides the whole segment; Footer: plan bar hides only the █░ fill and keeps `wk 32%`.
- Chatbox thinking chip prints the effective session level including `xhigh`/`max`; `/thinking` offers only `getSupportedThinkingLevels` (those two are opt-in). Do not clobber `ChatboxEditor.borderColor`.
- Live thinking is a 4-line max tail of the **full** thinking string (not the smooth-stream prefix). Do not pad empty rows; the slot grows 1→4 then rolls. History still collapses to `✻ Thought` + first sentence.
- `/undo` = same-session `navigateTree` rewind, no editor paste. `/edit` = that rewind then paste. Neither forks. `/rollback` still forks.
- Compact running subagent row is header + one `⎿` tools · tokens · time line. Do not hang thinking text. Do not print activity or `⚠ Subagent needs attention` TUI cards (`display: false`).
- Feature statuses ≠ TPS. Customize → Footer: TPS counter gates `tps`; statuses only gate plan/goal/swarm.
- Default parallel subagent launch is unlimited. Honor an explicit `concurrency` / config override. Do not restore the 4-wide default.
- xAI effort maps and Responses transport live in `generate-models.ts` / `xai-effort.ts` (grok-4.6+ `xhigh`; grok-4.5+ Responses). Humans do not invent catalog JSON; `withXaiEffortMetadata` also runs in `mergeCatalogLayers` so a stale shard cannot keep 4.6 on Completions. Named Completions exceptions go in `XAI_RESPONSES_EXCLUDED_MODEL_IDS`, not a frozen id allowlist.
- OpenCode free models follow `zen/v1/models` ∩ models.dev, not models.dev `deprecated` status. Do not add `opencode` to `LIVE_LIST_PROVIDER_IDS` (mixed APIs; `firstBakedInModel` would stamp the wrong one).
- Default-off watchdog startup must never fingerprint the repo; refresh effective config first and establish the repo-edit baseline only at `before_agent_start`.
- Settings menu descriptions name the feature, not every control inside it. Keep choice-specific limits and warnings beside the relevant choice or confirmation.

# Decisions (keep; why in one line)

- 2026-08-28: watchdog repo-edit fingerprints are lazy and effective-enable gated so an optional default-off reviewer cannot block prompt readiness.
- 2026-07-18: `.lunr/` split; keep `pi-*` scopes + `PI_CODING_AGENT_*`.
- 2026-07-22 / 08-15: no pi.dev catalog. `/refresh` = local `/models` + our GitHub `catalog/`.
- 2026-07-26: extension-absorption rolled back — baked-in extensions + bridges only. No “done” without live `npx lunr` + one message.
- 2026-07-28: cron in TUI + daemon; Discord discord.js; Telegram long-poll; authz fail-closed.
- 2026-08-03: do not add boot art. `qwen-cloud` ≠ token-plan. `/refresh` is the only refresh command.
- 2026-08-06: subscriptions sibling file; auth.json = active key; `autoManageSubscriptions` is manual switch only.
- 2026-08-07: yolo does not bypass swarm gate; detect via `[SWARM MODE]` prefix.
- 2026-08-08: `thinkingCollapse` layered on `hideThinkingBlock`; `/exit` = `/quit`.
- 2026-08-13: todos = extension, full-replace; plan approval = `present_plan`; custom provider writes models.json then login.
- 2026-08-14: plan is a permission mode; Shift+Tab `manual→yolo→plan→auto`; sticky chatbox in `packages/tui`; xAI `/usage` = weekly SuperGrok pool; usage bars use 70/90.
- 2026-08-15: `create()` cache-only (no first-paint hang). `/model` = stored cred, not env. Catalog generated + 4h CI. Official overwrites user-filled rows.
- 2026-08-15: `/refresh` live list must refresh expired OAuth the same way `getAuth` does; xAI 403 was a stale SuperGrok access token, not a bad `/models` URL.
- 2026-08-16: public install is `npm i -g @ashx-j/lunr`; publish-time rewrite of package.json **and** dist imports (0.1.0 missed JS; 0.1.1). Do not publish `@earendil-works/*`.
- 2026-08-16: xAI `/usage`+`/refresh` failures were a revoked lunR refresh token after `grok login` (same client); share `~/.grok/auth.json` and fail loud.
- 2026-08-16: model-tiers toggle must use `pi.registerTool`, not `pi.runtime` (not on ExtensionAPI); refresher errors must not be fatal.
- 2026-08-16: after sticky chat + alt-screen, native scrollback is gone; enable SGR mouse tracking and map wheel to `scrollChat`. Do not use DECSET 1007 (collides with editor history).
- 2026-08-16: TUI init called live `refresh()`; that plus localhost probes and uncapped OAuth made first boot after idle/reboot hang. First paint is cache-only.
- 2026-08-16: intermittent `/login xai` was refresh-token reuse, not a dead session. Do not adopt Grok on `modify(undefined)`, do not write epoch `expires_at`, do not abort refresh at 4s, do not remap timeout/403 to re-login.
- 2026-08-16: parent-delegated children inherit plan or auto; plan parents fail writer spawns; non-child print stays fail-closed.
- 2026-08-17: catalog cache-only was not the remaining hang. First paint still imported MCP/LSP/web-access/intercom/subagents; defer those until after `ui.start()`. Pi stays slow from live `pi.dev` + jiti of `~/.pi` packages.
- 2026-08-17: published 0.1.6 still hung because `init()` awaited deferred attach, startup auto-installed packages, and the Node import graph pulled jiti/providers/all/print-RPC. Time-to-type = `ui.start()` + light rebind; gate prompt/`/new`, not the editor. Skip missing-package install only on initial interactive reload.
- 2026-08-18: plan body is a chat card not a dock message; `/usage` is this-session context; `/token-usage` removed; completed todos prune on next user turn; mouse tracking stays on and messages select in-app; `/goal` forces session auto; compact subagent rows show model/thinking; goal complete is one agent message; pinned chat has a 1-col scrollbar.
- 2026-08-18: smoothStreaming must cache grapheme ends per content-block identity with append-only re-segment (message WeakMap went stale when providers did `block.text += delta`); always `requestRender` after reveal ticks and apply mid-stream toggle/hide-thinking without dumping unrevealed tail.
- 2026-08-19: v0.2.0 ships the three leftover product branches (open UX notes, compact tool chrome, smooth-streaming review). Already-on-master catalog/startup/permission work stays as-is; do not merge `archive/extension-absorption-DO-NOT-MERGE`.
- 2026-08-19: same-name tool rows collapse facing pad only; do not zero `paddingY` on every tool box.
- 2026-08-19: wheel/page/thumb only change `chatScrollOffset`; reuse pinned chat line cache. Do not sync-render in `setChatScroll`; do not width-probe every tall frame (Markdown single-width cache thrash).
- 2026-08-20: v0.2.1 ships same-tool spacing (#10) and pinned chat scroll cache (#11).
- 2026-08-20: consecutive same-name collapsed cards are header-only for every default-shell tool; subagent widgets stay; do not group by family.
- 2026-08-20: v0.2.2 ships same-tool stack for all tools (#12).
- 2026-08-20: consecutive same-name compact cards print the verb once and tree the details; do not repeat `● read` on every row.
- 2026-08-20: v0.2.3 ships the quieter same-name tool tree (#13).
- 2026-08-20: thinking-level copy drops fake token budgets; `/effort` and `/reasoning` alias `/thinking` (provider "reasoning effort" wording).
- 2026-08-20: v0.2.4 ships thinking aliases (#14).
- 2026-08-20: chatbox thinking indicator prints and tints xhigh/max; `/thinking` uses getSupportedThinkingLevels so it cannot advertise a level the session will clamp to high.
- 2026-08-20: v0.2.5 ships thinking chatbox levels (#15).
- 2026-08-20: grok-4.6+ xhigh is a generate-models overlay + catalog contract test; do not hand-edit `catalog/providers/xai.json`.
- 2026-08-20: stamp Grok 4.6+ xhigh in mergeCatalogLayers and rebind session.model after /refresh; catalog-only overlay is not enough while the session holds a stale Model object.
- 2026-08-23: grok-4.5+ uses Responses via `parseXaiGrok4Minor >= 5`, not `id === "grok-4.5"`. Overlay replaces Completions compat instead of merging it.
- 2026-08-20: v0.2.6 ships Grok 4.6 xhigh at catalog merge + session rebind (#17).
- 2026-08-20: v0.2.7 ships the same (0.2.6 failed tsgo on withXaiEffortMetadata compat unions).
- 2026-08-21: OpenCode Zen is already `opencode`; rotating free rows come from live `/v1/models` ∩ models.dev, not a new provider and not models.dev status.
- 2026-08-21: left-drag does not copy; scrollbar drag + SGR reset; `/undo` stays in-session, `/edit` pastes; live thinking is a 4-line latest tail; compact subagent hangs thinking; TUI hides needs-attention cards.
- 2026-08-21: v0.2.8 ships OpenCode Zen live free-model intersection (#18) and the TUI bug fixes.
- 2026-08-21: v0.2.9 ships product UX (#19): lunr tab title, Orchestrating spinner, fresh-only advertised subagents, per-tier thinking, `lunr update`, git/plan footer, click-to-expand.
- 2026-08-21: hide fork from the model instead of deleting internals so upstream sync still compiles; children are forced fresh.
- 2026-08-21: 5h plan bar preference falls back to weekly so xAI SuperGrok still shows a bar.
- 2026-08-21: workspace `npx lunr` is not a published install; do not self-update or nag it.
- 2026-08-21: compact subagent glyph seed is row identity only; thinking tokens were advancing the frame. Hang line is tools/tokens/time, not thinking. No Orchestrating prefix. Swarm footer is `swarm`. TPS is its own customize toggle. Parallel default is unlimited.
- 2026-08-21: same-name tree chrome uses `tree`, not `!isPartial`, so sequential running cards do not wait for completion. Live thinking does not pad empty rows to 4.
- 2026-08-23: VS Code image paste needs a host `sendSequence` for Alt+V; lunR cannot see a key the terminal never sends. Accept leaked `ESC v` even with Kitty on.
- 2026-08-23: collapsed same-name errors stay in the tree; hoist their bodies under the last leaf so the file list is not split.
- 2026-08-23: clipboard image paste shows `[image_n]` chips; keep the file off-screen and attach ImageContent on submit.
- 2026-08-23: v0.2.10 ships image chips, VS Code Alt+V, quieter subagent compact rows, unlimited parallel defaults, and grok-4.5+ Responses.
- 2026-08-24: same-turn SINGLE `subagent` calls count toward the swarm gate; one once/reject covers that assistant message. Sequential work stays `chain`.
- 2026-08-24: v0.2.11 ships same-turn swarm gate, gateway `/new` while busy, TUI cron deliver allowlist, models-store parse harden, git-flag walk, manual `code_rewrite` prompt.
- 2026-08-29: v0.2.12 ships agent memory + global AGENTS.md, prompt-driven subagents, Codex Fast/`/usage` cleanup, lunR system prompt, watchdog cold start, and lunR-branded shipped docs.
- 2026-08-30: v0.2.13 ships settings menu copy, mid-message skill tags, and Global AGENTS.md context labels.
- 2026-08-28: keep the prompt review artifact as the literal assembled effective prompt only; put provenance and regeneration notes in `AGENTS.md` so the snapshot contains no non-injected commentary.
- 2026-08-29: the default prompt is lunR-specific and schema-first; model changes refresh its runtime slug while existing context, skill, custom-prompt, and conditional injections stay intact.
- 2026-08-29: shipped coding-agent docs describe lunR (`@ashx-j/lunr`, `lunr`, `~/.lunr/`) so npmjs is not still pi; keep ExtensionAPI `pi` and `PI_*` names.
- 2026-08-29: prompt-driven subagents replace named types with task+description+full|read-only; Plan parents must pass read-only; no definition/saved-chain migration.
- 2026-08-29: keep private `childId` separate from the description-first UI; routing by display labels breaks live resume/steer and duplicate append ids misaddress children.
- 2026-08-29: separate immutable user behavior (`~/.lunr/agent/AGENTS.md`) from agent-managed durable facts; a global toggle hides memory injection/tools without deleting data.
- 2026-08-29: Fast mode is persisted only for `openai-codex`; paid `openai` API models never activate it.
- 2026-08-29: `/usage` renders all stored adapter plans, while the footer remains current-provider-only.
- 2026-08-29: Remove `/research` orchestration; generic subagents and web tools cover research without a product pipeline.
- 2026-08-30: distinguish the global instruction file by its resolved agent-dir path in the context breakdown so UI labels improve without changing prompt injection or project-file labels.
- 2026-08-30: mid-message skill tagging uses a dedicated `/settings` character (`+`/`~`/`$`) and inserts a tag only; do not reuse `/` or dump SKILL.md.
- 2026-08-30: `/settings` descriptions are short feature summaries so the menu stays scannable; choice details stay in submenus.

# Deferred

- Gateway cold first slash after daemon start can hang minutes.
- Live verify: Ollama/LM Studio, zai Bearer, multi-key rotation, catalog `/refresh` + `/model` after stability merge.
- Scope rename; `PI_CODING_AGENT*` rename; `/share` still pi.dev.
- Pin `^` + lockfile; ai catalog-drift `npm run build`.
- **`~/.pi` leakage (vendored copies only):** mcp-adapter, intercom broker, web-access keys/settings, pi-goal-state, simple-pi-memory (+ rollback snapshots that path), TUI crash log `~/.pi/agent/pi-crash.log`. Fix: route through `getAgentDir()` / set `PI_CODING_AGENT_DIR` at startup + migrate. Catalog no longer hits pi.dev.
- Rollback: shadow-git, gateway rollback (B7), orphan GC, symlink escape.
- Cron: script/`no_agent` jobs; more gateway platforms; process-tree for `nohup` grandchildren.
