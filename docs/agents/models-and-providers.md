# Models, catalog and providers

Read before changing the model catalog, model selection, login or provider transports.

## Catalog and selection

- Catalog: see `packages/coding-agent/docs/model-catalog.md`. Humans edit the generator/adapters and regenerate JSON; never hand-edit `catalog/providers/*.json`.
- Model facts come from models.dev, not code. A wrong fact goes in `packages/ai/src/catalog/rules.ts` with a `why`; never add id lists or id regexes to the generator. Provider endpoints and transports live in `packages/ai/scripts/catalog-providers.ts`.
- `npm --prefix packages/ai run generate-models -- --offline` regenerates from the last fetched sources, so two runs see identical inputs when comparing generator changes.
- Tests that exercise a transport build fixture models instead of `getModel("provider", "id")`: upstream sources drop models, and a pinned id breaks the build on the next regeneration. Catalog tests feed fixture models.dev rows to `modelsDevModels`.
- Multi-protocol providers pass their protocol union to `createProvider<...>` explicitly. Inferring it from the generated catalog broke compilation whenever upstream added or removed a protocol. `models.json` is one minified line on purpose; cache-only create prefers `official-catalog-cache.json`. There is no pi.dev catalog; `/refresh` is the only refresh command.
- Official rows without `compat`/`thinkingLevelMap` take a baked-in template in `refreshOfficialCatalog`: same id first, then the provider's first model. The first-model fallback gave Haiku 4.5 adaptive thinking, which Anthropic rejects.
- The shrink guard in `catalog-sources.ts` keeps a provider at its last-good copy when it loses more than 25% of at least ten models, and lets the rest of models.dev update. It used to reject the whole source, and one dropped provider (`iflowcn`, unused by lunR) froze every model from 2026-09-06 to 2026-10-25. A quarantined provider shows in `sources[].quarantined` of the published `catalog/publication.json` and stays frozen until someone checks the upstream change and deletes the `catalog-sources-v2-*` Actions caches.
- `ModelRuntime.getModel` prefers the available-snapshot row, which carries credential-specific limits from `filterModels`; the plain catalog row is the fallback.
- `/model` lists stored credentials only (`auth.json`, subscriptions, `--api-key`); ambient env keys do not list models but still resolve for a selected model. Logout deletes that provider's `models-store` + user-models. `/refresh` calls `getAuth` before `GET /models` so expired OAuth refreshes; it rebinds the session model.

## Providers

- xAI shares the official `grok` OAuth client, rotates refresh tokens and revokes the family on reuse. Adopt `~/.grok/auth.json` only when lunR is expired or after `invalid_grant`; write RFC3339 `expires_at`; never overwrite a newer Grok family or treat `modify(undefined)` as adopt. Remap to re-login only on `invalid_grant`/revoked refresh (`/usage` also on 401 billing), never on timeout or 403. Token refresh caps at 30s.
- xAI effort maps and Responses transport live in `generate-models.ts` / `xai-effort.ts` (grok-4.6+ `xhigh`; grok-4.5+ Responses via `parseXaiGrok4Minor`). `withXaiEffortMetadata` also runs in `mergeCatalogLayers`. Completions exceptions go in `XAI_RESPONSES_EXCLUDED_MODEL_IDS`; Completions compat must not leak onto Responses.
- OpenAI GPT effort floors live in `generate-models.ts` / `openai-effort.ts` as fallback; provider maps win. Codex generation and live discovery share `packages/ai/src/catalog/codex.ts`. Discovery is client-version-gated: an old version can return 200 without new models.
- Codex uses each route's `context_window` as its compaction budget; `max_context_window` never becomes the default. Fast mode persists only for `openai-codex`.
- OpenCode free models follow `zen/v1/models` ∩ models.dev, not models.dev `deprecated` status. Do not add `opencode` to `LIVE_LIST_PROVIDER_IDS`.

## Claude subscriptions

- `/login anthropic` downloads pinned Claude Code (`CLAUDE_CODE_VERSION` 2.1.263) into `~/.lunr/agent/claude-code/<version>/` after confirmation, verifies per-platform integrity and reuses Claude Code's own sign-in. Setup reads the picker (`initialize`), then `set_model` + `get_context_usage` per route, and saves a version 3 record `models: [{ id, route, contextWindow }]` in picker order. It skips variants whose description mentions usage credits (no structured billing field). Version 1 and 2 records need `/login anthropic`.
- Subscription turns use an injected SDK `fetch`: Claude Code sends the request straight to Anthropic; lunR rebuilds SSE from `--include-partial-messages` `stream_event` lines, stops Claude Code at `message_stop`, and rebuilds HTTP errors from `api_error_status`. `terminal_reason: api_error` without status is a retryable network error. Local failures travel as SSE `error` because the SDK hides `fetch` exceptions. The loopback serves only the MCP tool inventory. The bridge stamps the request model on every assistant frame or Claude Code drops signed thinking.
- Never set `ANTHROPIC_BASE_URL` for a real subscription turn, read Claude Code credentials, restore pi's Claude Code OAuth route, or fall back to direct OAuth HTTP. Setup discovery points Claude Code at a TCP tripwire that passes only the credential-free `HEAD /api/hello` warm-up (sent unless a proxy, socket or client cert is set). Bumping `CLAUDE_CODE_VERSION` needs all eight platform integrity values and a fresh live qualification.
- The AI package loads the Claude Code bridge through a computed import specifier; a literal path breaks the browser smoke check.
- Offline test setup for the real binary is in [testing.md](testing.md).
