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

Read this file first; ask when ambiguous; touch only the task; small why-commits. No drive-by rewrites; check existing deps before adding. Never commit secrets; never force-push shared branches; confirm destructive git. Branch + PR before merge. Public docs: no local setup/secrets. **This file is the source of truth — after work update Current State + build/test, append Decisions (one-line why), gotchas under Notes. Delete stale entries. Committed detail lives in git log.**

---

# Current State

Last updated: 2026-08-17. **`origin/master` = `78386ec`**. Public npm is `@ashx-j/lunr@0.1.6` (tag `v0.1.6`). **NEVER MERGE `archive/extension-absorption-DO-NOT-MERGE`.** Untracked locals: `prompts/`, `DESIGN.md`, `LUNR_SYSTEM_INJECTION.md`, `lunR-checklist.md`, `.pi-subagents/`.

## On origin/master (`78386ec`)

- **Catalog (pi-style):** `generate-models.ts --strict --json-only` → `.artifacts/model-catalog`; `scripts/sync-model-catalog.mjs` validates (≥500 models; require anthropic/openai/openrouter) → `catalog/` (`models.json` minified, `providers.json`, `providers/{id}.json`, `publication.json`). CDN = GitHub raw `master/catalog/`. `/refresh` GETs `providers.json` (4s) then shards only for **stored-cred** providers (4s; skip 404). Fallback: `~/.lunr/agent/official-catalog-cache.json` → bundled `catalog/` (`copy-assets` → `dist/catalog/`). Merge: official > user-models > live `/models` > baked-in `*.models.ts`. New live ids can prompt (cap 8); official id evicts user row. Humans edit the **generator**, not the JSON. CI `.github/workflows/publish-model-catalog.yml` every 4h + dispatch. `npm run sync:model-catalog`. No R2, no `pi.dev`. `catalog/official-models.json` gone.
- **`/refresh` OAuth:** live list calls `getAuth` before `GET /models` so expired SuperGrok tokens refresh (`ec59883` / PR #4). Toast reports only attempted providers and includes `error`. Remap to `xai login expired (run /login xai)` only on `invalid_grant` / revoked refresh, not a timeout or generic OAuth error. Tests: catalog-auth + catalog-merge.
- **xAI SuperGrok + Grok CLI:** same OAuth client as official `grok`. xAI rotates refresh tokens and revokes the family on reuse. lunR keeps its own live rotation when Grok still has the previous family; adopts `~/.grok/auth.json` only when lunR is expired or after `invalid_grant`. Write-through uses RFC3339 `expires_at`, refuses to overwrite a newer Grok family, and does not treat `modify(undefined)` as adopt. `/login xai` can import the Grok CLI session. `/logout xai` does not delete `~/.grok/auth.json`. `/usage` remaps only 401 billing + `invalid_grant` to `xAI login expired. Run /login xai.` Tests: grok-cli-auth + catalog-auth + usage-service.
- **`/model` listing:** stored cred only (`auth.json` / subscriptions / `--api-key`). Ambient `OPENROUTER_API_KEY` does not list models. `getAuth`/stream still resolve env if a model is already selected. Logout deletes that provider’s `models-store` + user-models. Tests: catalog-auth.
- **`create()` cache-only:** `refresh({ allowNetwork: false })`. No GitHub / provider lists at `ModelRuntime.create()`. `withRemoteCatalog` deleted.
- **Cold start:** TUI init/footer uses `refreshModelCandidatesForInit` (cache-only). Official overlay on every stored-cred provider. Shard-merge cache (failed shard keeps old rows). `refresh()` is single-flight and keeps in-memory GitHub rows. Offline `/refresh` skips Ollama Cloud. Cloud `session_start` is cache-only. Local Ollama/LM Studio probes skip on `allowNetwork: false` and use `127.0.0.1`. xAI token refresh hard-caps at 30s (4s aborted after xAI had already rotated). Auth.json lock stale is 120s; writes are tmp+rename. `lunr gateway` lazy-imports discord.js. fd/rg download is background. V8 compile cache at `~/.lunr/agent/compile-cache`. `PI_TIMING=1` now labels ModelRuntime/resourceLoader/TUI init. Interactive first paint loads `lightBuiltinExtensions` only; MCP / LSP / web-access / intercom / subagents / prompt-template attach after `ui.start()` via `attachInlineExtensions`. Print / RPC / gateway still load the full roster before the first turn. `--api-key` is cache-only at create. npm/git package install times out at 30s. Tests: model-runtime-startup + official-catalog + catalog-auth + lunr-local-providers + xai-oauth + deferred-builtin-extensions.
- **Also on master (see git log):** sticky chatbox + plan-as-permission-mode + xAI weekly `/usage` + traffic-light bars (`3a8d843`); TUI batch + cache hit-rate (`3cf89f9`); npm-audit workflow manual-only (`8266ede`).
- **Model-tiers toggle:** `/settings` Enable model tiers used `pi.runtime.refreshTools()`; `pi` is `ExtensionAPI` and has no `runtime`. Fix: `pi.registerTool(tool)` + bridge swallows refresher throws. Tests: `model-tiers.test.ts`.
- **Session wheel:** sticky chat + alt-screen has no native scrollback. TUI enables SGR 1000+1006 while pinned; wheel → `scrollChat` (±3, Ctrl+wheel pages). Shift+drag still selects. Tests: `mouse.test.ts` + `tui-pin.test.ts`.
- **Child permission inherit:** parent snapshot `PI_SUBAGENT_PARENT_PERMISSION_MODE` at spawn. Child `PI_SUBAGENT_CHILD=1` resets to `plan` or `auto` in `main.ts` before tools. Plan parent fails writer/write-tool launches (`PLAN_MODE_WRITE_SPAWN_ERROR`); read-only children stay blocked for writes. Non-child `lunr -p` stays fail-closed. Tests: `subagent-permission-inherit.test.ts` + permissions fail-closed.

## Installer

- **Install:** `npm i -g @ashx-j/lunr` (Node ≥ 22.19). Current published: **0.1.6**.
- Workspace names stay `@earendil-works/pi-*`. `scripts/publish.mjs` rewrites **package.json and compiled JS/d.ts imports** to `@ashx-j/lunr{,-ai,-tui,-agent}`. Rewriting names only is not enough — `0.1.0` crashed with `Cannot find package '@earendil-works/pi-ai'`.
- CI: `.github/workflows/publish-npm.yml` on `v*` + `secrets.NPM_TOKEN`. Never publish `@earendil-works/*`.

## Not merged

- None for product. Dirty working-tree stash on `fix/cold-start`: gateway `/new` while busy, cron deliver allowlist, models-store parse harden, plan-mode `code_rewrite`/`git` flags.

## Uncommitted (working tree)

- Stashed off this cut: gateway `/new` abort, cron deliver allowlist, models-store corrupt-JSON parse, plan-mode `code_rewrite` + git-flag walk.

## Build & run

- Compile ai with `npx tsgo -p packages/ai/tsconfig.build.json` (offline). Then agent → coding-agent → orchestrator.
- JSON catalog: `npm run sync:model-catalog` (needs network). Do not hook generate into root `npm run build`.
- `npx lunr --version` / published CLI → **0.1.6**. **Rebuild coding-agent `dist` after merge** or features look missing.
- Commits often `--no-verify` (`check:pinned-deps` vs unpinned `^`).
- `npx lunr --print` does not self-exit here — wrap with `timeout`.

---

# Architecture

- **Features = baked-in extensions + bridges.** `builtin-extensions/` (inline factories in main.ts; hidden; vendored `// @ts-nocheck`; biome-excluded). Roster: simple-pi-memory, pi-tps, ashxj-tui, pi-ollama-cloud, ashxj-spinners, ashxj-thinking, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, pi-lsp-extension, pi-mcp-adapter, lunr-local-providers, lunr-behavior, lunr-cron, lunr-todos, lunr-plan-tools, lunr-skill-creator. Removed: context-mode, MattDevy + narumiruna collections.
- **Bridges:** `globalThis[Symbol.for("@lunr/...")]`. Never runtime-barrel-import `@earendil-works/pi-coding-agent` under `builtin-extensions/` — concrete modules only. `complete`/`streamSimple`/`getModel` from `@earendil-works/pi-ai/compat`.
- **Cron:** `core/cron` in TUI (live session) and gateway (fresh headless session). One `jobs.json` `~/.lunr/agent/cron/`. `runWithOrigin` ALS. Gateway fallback: `cronFallbackModels`.
- **Gateway:** Telegram long-poll + Discord (mention-gated, no GuildMembers intent). Authz fail-closed. `ADAPTER_FACTORIES`.
- **Footer:** ashxj-tui `setFooter` only. Toggles are render-time `CustomizeBridge` reads.
- **Permissions:** `manual | yolo | plan | auto`; Shift+Tab cycles that order. Plan = `gateToolCall` + `PLAN_MODE_ADDENDUM`. Fail-closed without handler. Swarm (>2 parallel in one call) gated in manual AND yolo.
- **Rollback:** per-turn snapshots; persistent rewind via `fork`; `/undo` forks, no file restore.

# Renamed vs still "pi"

Renamed: bin `lunr`, `.lunr/`, `APP_NAME`. **Never write `~/.pi/`.** Still pi: `@earendil-works/pi-*` scopes, `PI_CODING_AGENT*` env, `getPiUserAgent`, `/share` default `https://pi.dev/session/`.

# Notes

- Theme: `moon.json` is the builtin; `default.json` untracked/unwired. Glyphs `promptMoon`/`promptArrow`; `promptSymbol` is master on/off.
- Mouse tracking is on while the chat dock is pinned. Shift+drag to copy; wheel without Shift scrolls the session.
- Selectors: keybinding layer (`tui.select.cancel`), never raw `\x1b` (Kitty CSI-u).
- Win32: Ctrl+V is the terminal’s; image paste is `Alt+V`.
- Process registry: direct children only; `nohup &` grandchildren untracked.
- vite/oxc: `import type { A, B }` not `import type { A, type B }`.
- Telegram length = `string.length` (UTF-16). Busy-session `/stop` `/new` must bypass session guard.
- `// lunr:` = upstream edit markers. Hot sync files: `ashxj-tui.ts`, `interactive-mode.ts`, `agent-session.ts`, `bash.ts`, `settings-manager.ts`, `main.ts`, `builtin-extensions/*`.
- Injected-prompt collapse is render-only (`[SWARM MODE]` / `[DEEP RESEARCH]` / goal marker).
- `/plan <task>`: enter plan + send; if already in plan, restore previous mode + send.
- Catalog: `models.json` is one minified line on purpose; `/refresh` does not download it (shards only).
- **Stop proposing boot-screen art.** Slim box only; ask first.

# Decisions (keep; why in one line)

- 2026-07-18: `.lunr/` split; keep `pi-*` scopes + `PI_CODING_AGENT_*`.
- 2026-07-22 / 08-15: no pi.dev catalog. `/refresh` = local `/models` + our GitHub `catalog/`.
- 2026-07-26: extension-absorption rolled back — baked-in extensions + bridges only. No “done” without live `npx lunr` + one message.
- 2026-07-28: cron in TUI + daemon; Discord discord.js; Telegram long-poll; authz fail-closed.
- 2026-08-03: do not add boot art. `qwen-cloud` ≠ token-plan. `/refresh` is the only refresh command.
- 2026-08-06: subscriptions sibling file; auth.json = active key; `autoManageSubscriptions` is manual switch only.
- 2026-08-07: yolo does not bypass swarm gate; detect via `[SWARM MODE]` prefix.
- 2026-08-08: `thinkingCollapse` layered on `hideThinkingBlock`; `/exit` = `/quit`.
- 2026-08-13: todos = extension, full-replace; plan approval = `present_plan`; custom provider writes models.json then login; `/usage` totals vs `/token-usage` per-model.
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

# Deferred

- Gateway cold first slash after daemon start can hang minutes.
- Live verify: Ollama/LM Studio, zai Bearer, multi-key rotation, catalog `/refresh` + `/model` after stability merge.
- Scope rename; `PI_CODING_AGENT*` rename; `/share` still pi.dev.
- Pin `^` + lockfile; ai catalog-drift `npm run build`.
- **`~/.pi` leakage (vendored copies only):** mcp-adapter, intercom broker, web-access keys/settings, pi-goal-state, simple-pi-memory (+ rollback snapshots that path), TUI crash log `~/.pi/agent/pi-crash.log`. Fix: route through `getAgentDir()` / set `PI_CODING_AGENT_DIR` at startup + migrate. Catalog no longer hits pi.dev.
- Rollback: shadow-git, gateway rollback (B7), orphan GC, symlink escape.
- Cron: script/`no_agent` jobs; more gateway platforms; process-tree for `nohup` grandchildren.
