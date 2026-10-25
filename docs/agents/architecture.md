# Architecture

Read before adding features, extensions or bridges, or before syncing from upstream pi.

- **Features = baked-in extensions + bridges.** `builtin-extensions/` (factories registered in `builtin-extensions/index.ts`; hidden; vendored, mostly `// @ts-nocheck`; biome-excluded).
  - Light roster: simple-pi-memory, pi-tps, ashxj-tui, ashxj-spinners, ashxj-thinking, lunr-local-providers, lunr-todos, lunr-plan-tools, lunr-skill-creator.
  - Deferred (interactive after paint; print/RPC/gateway before first turn): pi-ollama-cloud, narumiruna-pi-goal, lunr-cron, lunr-pr-watch, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, lunr-browser, pi-lsp-extension, pi-mcp-adapter, lunr-computer-use.
  - Removed: lunr-settings-tools, lunr-behavior, context-mode, MattDevy + narumiruna collections. Extension absorption was rolled back; **never merge `archive/extension-absorption-DO-NOT-MERGE`.**
- **Bridges:** `globalThis[Symbol.for("@lunr/...")]`. Never runtime-barrel-import `@earendil-works/pi-coding-agent` under `builtin-extensions/`, only concrete modules. `complete`/`streamSimple`/`getModel` come from `@earendil-works/pi-ai/compat`.
- **Cron:** `core/cron` in TUI (live session) and gateway (fresh headless session). One `jobs.json` in `~/.lunr/agent/cron/`. `runWithOrigin` ALS. Gateway fallback: `cronFallbackModels`. TUI cron uses the gateway's deliver allowlist. Schedulers without the lease retry it every tick; ownership counts only after `recoverInterruptedRuns` succeeds. A TUI owner skips, without claiming, jobs from other projects or with non-local targets (`SchedulerDeps.accepts`); missed one-shots go through `deliverFailure`. `cron resume` clears `interrupted` and the lease owner runs the job once.
- **Gateway:** Telegram long-poll + Discord (mention-gated, no GuildMembers intent). Authz fail-closed. `ADAPTER_FACTORIES`. Details in [integrations.md](integrations.md).
- **ACP:** `lunr --mode acp` adapts pi-acp with one native RPC worker per ACP session. Setup, limits and T3 settings: `packages/coding-agent/docs/acp.md`.
- **Footer:** ashxj-tui `setFooter` only. Toggles are render-time `CustomizeBridge` reads.
- **Permissions:** see [permissions-and-memory.md](permissions-and-memory.md).
- **Rollback:** per-turn snapshots; `/rollback` forks and restores files. `/undo` rewinds the same session via `navigateTree` with no editor paste; `/edit` does that rewind then pastes. Neither forks.

## Renamed vs still "pi"

- Renamed: bin `lunr`, `.lunr/`, `APP_NAME`. **Never write `~/.pi/`.**
- Still pi: `@earendil-works/pi-*` scopes, `PI_CODING_AGENT*` env, `getPiUserAgent`, ExtensionAPI `pi`, package.json `"pi"`. pi-mcp-adapter still reads a legacy project `.pi/mcp.json` and treats `.pi` as a project-root marker on purpose.

## Code conventions

- `// lunr:` marks upstream edits. Hot sync files: `ashxj-tui.ts`, `interactive-mode.ts`, `agent-session.ts`, `bash.ts`, `settings-manager.ts`, `main.ts`, `builtin-extensions/*`.
- vite/oxc: `import type { A, B }`, not `import type { A, type B }`.
- New top-level CLI subcommands must be added to `DEFERRED_COMMANDS` in `startup/launch-routing.ts`; otherwise a TTY launch paints the chat TUI first and its editor also consumes the command's input.
- `--provider` only narrows `--model` lookup (`resolveCliModel`); it has no default and does nothing alone. Without `--model` the saved default model applies.
- Read `PI_OFFLINE` through `isOfflineModeEnabled()` (1/true/yes); a raw `!== undefined` check treated `0` as offline.
- Process registry tracks direct children only; `nohup &` grandchildren are untracked.
- Lazy extension lifecycle: session replacement invalidates pending work before new work binds. Await extension `session_shutdown` before gateway/cron disposal. MCP closes partial connections and shares one shutdown promise; LSP serializes shutdown and bind; `subagent_wait` waits only for pending launch registration.
- Agent loop: an abort during tool preparation or execution turns unstarted calls into "Operation aborted" results and ends the run without another provider request; queued steering and follow-ups stay queued. A stream that ends without done/error becomes an error message.
- `AuthStorage.reload` reads `auth.json` without the lock and keeps the last snapshot on an empty or unparsable file. Session files are created 0600 and directories lunR creates 0700. `navigateTree` (`/tree`, RPC) refuses while a run is active.
- Extension aliases match prefixes. Keep the AI catalog directory ahead of its root compatibility-file alias.
- Usage records live in session custom entries outside model context. Request IDs survive receipt replay; forks carry context but no new spend. Unknown usage and prices stay distinct from measured zero.

## Agent-facing prompt and tools

- Tool schemas are the always-available discovery layer. Keep recovery/workflow instructions conditional in tool results where possible; reserve base-prompt rules for guidance required before the first call.
- First-request fixtures hash the full default tool payload. Refresh both browser hashes after any agent-facing schema change (see [testing.md](testing.md)).
- `LUNR_SYSTEM_INJECTION.md` is a local point-in-time effective-prompt snapshot, not an input. Regenerate it after changes to `system-prompt.ts`, active tools/extensions, `AGENTS.md`, skills, permission mode, goal state, memory, or `~/.lunr/agent/agents/AGENTS.md`.
