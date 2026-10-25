# Models, catalog and providers

Read before changing the model catalog, model selection, login or provider transports.

## Catalog and selection

- Catalog: see `packages/coding-agent/docs/model-catalog.md`. Humans edit the generator/adapters and regenerate JSON; never hand-edit `catalog/providers/*.json`. `models.json` is one minified line on purpose; cache-only create prefers `official-catalog-cache.json`. There is no pi.dev catalog; `/refresh` is the only refresh command.
- Official rows without `compat`/`thinkingLevelMap` take a baked-in template in `refreshOfficialCatalog`: same id first, then the provider's first model. The first-model fallback gave Haiku 4.5 adaptive thinking, which Anthropic rejects.
- The shrink guard in `catalog-sources.ts` rejects a whole source when any one provider in it shrinks by more than 25%. A provider models.dev dropped (`iflowcn`, unused by lunR) froze models.dev at the 2026-09-06 copy until 2026-10-25. Check `sources[].status` in the published `catalog/publication.json`; a `cached` models.dev entry means new models are missing. Recovery: delete the `catalog-sources-v2-*` Actions caches, then dispatch the workflow.
- `ModelRuntime.getModel` prefers the available-snapshot row, which carries credential-specific limits from `filterModels`; the plain catalog row is the fallback.
- Logout and startup remove global `enabledModels` entries shaped `provider/...` whose registered provider fails `checkAuth` (`findSignedOutScopePatterns`). An env key still counts as a credential, so `/logout` of a stored key keeps the scope while the env key exists.
- `/model` lists stored credentials only (`auth.json`, subscriptions, `--api-key`); ambient env keys do not list models but still resolve for a selected model. Logout deletes that provider's `models-store` + user-models. `/refresh` calls `getAuth` before `GET /models` so expired OAuth refreshes; it rebinds the session model.

## Providers

- xAI shares the official `grok` OAuth client, rotates refresh tokens and revokes the family on reuse. Adopt `~/.grok/auth.json` only when lunR is expired or after `invalid_grant`; write RFC3339 `expires_at`; never overwrite a newer Grok family or treat `modify(undefined)` as adopt. Remap to re-login only on `invalid_grant`/revoked refresh (`/usage` also on 401 billing), never on timeout or 403. Token refresh caps at 30s.
- xAI effort maps and Responses transport live in `generate-models.ts` / `xai-effort.ts` (grok-4.6+ `xhigh`; grok-4.5+ Responses via `parseXaiGrok4Minor`). `withXaiEffortMetadata` also runs in `mergeCatalogLayers`. Completions exceptions go in `XAI_RESPONSES_EXCLUDED_MODEL_IDS`; Completions compat must not leak onto Responses.
- OpenAI GPT effort floors live in `generate-models.ts` / `openai-effort.ts` as fallback; provider maps win. Codex generation and live discovery share `packages/ai/src/catalog/codex.ts`. Discovery is client-version-gated: an old version can return 200 without new models.
- Codex uses each route's `context_window` as its compaction budget; `max_context_window` never becomes the default. Fast mode persists only for `openai-codex`.
- OpenCode free models follow `zen/v1/models` ∩ models.dev, not models.dev `deprecated` status. Do not add `opencode` to `LIVE_LIST_PROVIDER_IDS`.

## Claude subscriptions

- `/login anthropic` downloads pinned Claude Code (`CLAUDE_CODE_VERSION` 2.1.310, in browser-safe `auth/anthropic-route.ts`; hashes in `utils/claude-code-release.ts`) into `~/.lunr/agent/claude-code/<version>/` after confirmation, verifies per-platform integrity and reuses Claude Code's own sign-in. Setup reads only the picker (`initialize`) and saves a version 3 record `models: [{ id, route, contextWindow? }]` in picker order. It skips variants whose description mentions usage credits (no structured billing field). Version 1 and 2 records need `/login anthropic`.
- Since 2.1.310, `set_model` checks model access with Anthropic and `get_context_usage` sends `count_tokens`, so setup calls neither. A `[1m]` route records 1M; other routes omit `contextWindow` and `filterModels` keeps the catalog window. Records from 2.1.263 keep their measured windows. `/refresh` shows `claudeCodeUpdateNote` while the record's binary is older than the pin, because its model list came from that older picker.
- 2.1.310 adds its own `# Environment` note (working directory, platform) and model identity as `role: "system"` messages. `CLAUDE_CODE_SIMPLE` would drop them but also disables the subscription sign-in, so the bridge spawns Claude Code in lunR's working directory to keep the note true. Empty `--setting-sources` keeps that directory's CLAUDE.md and settings out.
- Subscription turns use an injected SDK `fetch`: Claude Code sends the request straight to Anthropic; lunR rebuilds SSE from `--include-partial-messages` `stream_event` lines, stops Claude Code at `message_stop`, and rebuilds HTTP errors from `api_error_status`. `terminal_reason: api_error` without status is a retryable network error. Local failures travel as SSE `error` because the SDK hides `fetch` exceptions. The loopback serves only the MCP tool inventory. The bridge stamps the request model on every assistant frame or Claude Code drops signed thinking.
- Never set `ANTHROPIC_BASE_URL` for a real subscription turn, read Claude Code credentials, restore pi's Claude Code OAuth route, or fall back to direct OAuth HTTP. Setup discovery points Claude Code at a TCP tripwire that passes only the credential-free `HEAD /api/hello` warm-up (sent unless a proxy, socket or client cert is set). Bumping `CLAUDE_CODE_VERSION` needs all eight platform integrity values and a fresh live qualification.
- The AI package loads the Claude Code bridge through a computed import specifier; a literal path breaks the browser smoke check.
- Offline test setup for the real binary is in [testing.md](testing.md).
