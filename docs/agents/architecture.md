# Architecture

Read before adding features, extensions or bridges, or before syncing from upstream pi.

- **Features = baked-in extensions + bridges.** `builtin-extensions/` (factories registered in `builtin-extensions/index.ts`; hidden; vendored; 60 files still `// @ts-nocheck`: pi-subagents 39, pi-mcp-adapter 9, pi-web-access 7, pi-prompt-template-model 3, pi-intercom 2; biome-excluded).
  - Light roster: simple-pi-memory, pi-tps, ashxj-tui, ashxj-spinners, ashxj-thinking, lunr-local-providers, lunr-todos, lunr-plan-tools, lunr-skill-creator.
  - Deferred (interactive after paint; print/RPC/gateway before first turn): pi-ollama-cloud, narumiruna-pi-goal, lunr-cron, lunr-pr-watch, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, lunr-browser, pi-lsp-extension, pi-mcp-adapter, lunr-computer-use.
  - Removed: lunr-settings-tools, lunr-behavior, context-mode, MattDevy + narumiruna collections. Extension absorption was rolled back; **never merge `archive/extension-absorption-DO-NOT-MERGE`.**
- **Bridges:** `globalThis[Symbol.for("@lunr/...")]`, read and written through `globalBridge<T>(symbol)` in `core/global-bridge.ts`. Never runtime-barrel-import `@earendil-works/pi-coding-agent` under `builtin-extensions/`, only concrete modules. `complete`/`streamSimple`/`getModel` come from `@earendil-works/pi-ai/compat`.
- **Cron:** `core/cron` in TUI (live session) and gateway (fresh headless session). One `jobs.json` in `~/.lunr/agent/cron/`. `runWithOrigin` ALS. Gateway fallback: `cronFallbackModels`. TUI cron uses the gateway's deliver allowlist. Schedulers without the lease retry it every tick; ownership counts only after `recoverInterruptedRuns` succeeds. A TUI owner skips, without claiming, jobs from other projects or with non-local targets (`SchedulerDeps.accepts`); missed one-shots go through `deliverFailure`. `cron resume` clears `interrupted` and the lease owner runs the job once. When the TUI owner skips due jobs it releases the lease for a gateway and waits `handoffBackoffTicks` (3) before retrying, so with no gateway its own jobs can run up to about 3 minutes late.
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
- Compaction caps `reserveTokens` at 25% and `keepRecentTokens` at 40% of the model window (`compactionSettingsForWindow`); `prepareCompaction` takes the window as its third argument. Below about 65k tokens the caps apply; larger windows keep 16384/20000.
- `compaction.ceilingTokens` lowers the trigger to `min(window - reserve, ceiling)` (`compactionThreshold`), with the ceiling raised to at least 2 × the compacted size (`compactionCeilingFloor`). The compacted size is the larger of prompt and tools + kept + reserve and `_compactedContextTokens`, the estimate of the rebuilt context recorded when a compaction succeeds (prefix plus `estimateMessagesTokens`, never provider usage, so a retried or zero-usage request can't change it; not persisted, so a resumed session starts from the estimate floor), which covers a kept tool batch larger than `keepRecentTokens`. The system prompt plus tool schemas measured 16k tokens in print mode and 18k in the TUI with a clean profile; MCP servers add to that and deferred tool loading cuts it, so the floor follows the measured prefix. A floor of only one compacted context left 16k to 23k tokens of room, so a 2-read prompt compacted every time. A set ceiling also turns on the between-tool-turn check in `_installAgentNextTurnRefresh` that only Codex had, and a failed or cancelled ceiling compaction (between tool turns or at a prompt's opening check) stops it until just before the next prompt's opening check; with no ceiling, compaction is identical to master. `flushCompactionQueue` steers queued messages into a run that is still streaming after a compaction ends, since a failed or cancelled one reports `willRetry: false`. `_compactionPrefixTokens` runs only with a ceiling and caches on the prompt string and tools array (1.4 ms per uncached count).
- `lunr doctor` counts a provider as ready when the runtime resolves auth for it, and reports saved logins, env keys, custom providers and local servers separately. It builds a cache-only runtime with `grokHome: null` so it cannot write auth.json.
- `packages/agent` no longer has the `harness`; `uuidv7` lives in `src/uuid.ts`.
- Extension aliases match prefixes. Keep the AI catalog directory ahead of its root compatibility-file alias.
- Usage records live in session custom entries outside model context. Request IDs survive receipt replay; forks carry context but no new spend. Unknown usage and prices stay distinct from measured zero.

## Agent-facing prompt and tools

- Tool schemas are the always-available discovery layer. Keep recovery/workflow instructions conditional in tool results where possible; reserve base-prompt rules for guidance required before the first call.
- First-request fixtures hash the full default tool payload. Refresh both browser hashes after any agent-facing schema change (see [testing.md](testing.md)).
- `LUNR_SYSTEM_INJECTION.md` is a local point-in-time effective-prompt snapshot, not an input. Regenerate it after changes to `system-prompt.ts`, active tools/extensions, `AGENTS.md`, skills, permission mode, goal state, memory, or `~/.lunr/agent/agents/AGENTS.md`.
