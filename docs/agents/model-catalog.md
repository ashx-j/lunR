# Model catalog maintenance

Routine catalog updates use HTTP requests and deterministic TypeScript normalization, with no AI inference or agent runs.

## Discovery and precedence

The public generator combines models.dev, OpenRouter, Vercel, NVIDIA, OpenCode Zen/Go, and OpenAI's published Codex metadata. Codex model IDs come from that upstream document, not a handwritten list.

Every tool-capable models.dev model of a shipped provider becomes a catalog row, so a new model appears in the next hourly publication after models.dev lists it. Model facts come from data:

- Limits, prices (including long-context price tiers), image input and thinking levels come from the model's models.dev row. A gateway row that leaves a capability out takes it from the lab's own row (`canonical_model_id`), and a temperature rejection on either row holds.
- Thinking levels follow `reasoning_options`. A level the model does not list is hidden; effort `none` or a toggle allows "off". Claude models with effort `max` use adaptive thinking.
- `packages/ai/scripts/catalog-providers.ts` says which models.dev providers ship and how lunR reaches each one (endpoint, transport, provider-wide request settings).
- models.dev providers no hand-written source covers ship as generic providers when they have an OpenAI- or Anthropic-compatible endpoint, an API key variable and at least one agent model. The generator writes their definitions to `packages/ai/src/providers/models-dev-providers.generated.ts`, so they appear in `/login`. Their models come from the published catalog after login and from their own model list, not from the CLI bundle. A newly listed provider arrives with the next CLI release; its models arrive hourly.
- `packages/ai/src/catalog/rules.ts` patches the few facts the sources get wrong. Each rule names its reason, and a rule may only drop a model when it says why.

At runtime, lunR also reads each logged-in provider's own model list, so a model shows up in `/model` within the hourly refresh after the provider starts serving it, even before models.dev lists it:

- OpenAI-compatible providers answer `GET {baseUrl}/models`. Anthropic (API keys only, never a Claude subscription) reports each model's limits, thinking types and effort levels. Google's list reports limits and thinking support for models that generate content. Mistral reports chat and tool support.
- A listed id the catalog already has keeps its catalog row and takes only the fields the provider reported (name, limits, image input, whether it reasons).
- A new id goes through the same resolver the catalog generator uses (`packages/ai/src/catalog/providers.ts`): the provider's reported fields first, then the closest models.dev model from the published `facts.json`, then the catalog rules. The CLI downloads `facts.json` only when a list names a new id. With nothing known, the model gets 128k context, 8k output and no thinking controls, and its price shows as unknown. New ids that look like embedding, speech, image or safety models are skipped.
- A provider without a list endpoint answers 400, 404 or 405; that refresh stays quiet and keeps the provider's catalog rows. A 401 or 403 shows in `/refresh` but does not make the automatic refresh retry early. Anthropic and Google lists are read only with an API key; other logins skip them quietly. OpenCode, Copilot, NVIDIA, Bedrock, Vertex, Azure and the Cloudflare gateways are not listed (see `UNLISTED_PROVIDERS` in `live-catalog.ts`).

Codex uses the authenticated account-specific `/codex/models` endpoint, including its client-version query and account header. The client version is resolved from official npm release metadata; only JSON metadata is fetched, never package code. If that lookup fails, discovery uses its last successful version or the bundled fallback.

Provider-supplied capability fields override older published metadata for the same model. Missing fields use existing exact-model metadata or conservative defaults; unknown prices are marked unavailable in the picker. Explicit `models.json` and extension model configuration are applied last. API-specific transport compatibility remains code-owned.

A successful Codex account list controls picker availability, including hidden models. Existing model records remain resolvable for saved sessions and explicit configuration. Codex context limits are route-specific: its default context is not necessarily the maximum advertised for the OpenAI API. Unknown reasoning levels are retained as metadata but are not offered or sent until lunR supports them. Server prompt templates are not imported.

## Refresh and recovery

Interactive startup uses cached or bundled data without catalog network requests. After prompt readiness, an idle poll checks for refreshes; successful automatic refreshes are limited to once an hour per runtime/account configuration, with a one-minute retry delay on failure. Active turns retain their model object, and shutdown cancels the poll. `/refresh` bypasses the freshness gate. The model picker and CLI model listing also request a freshness check; unresolved explicit CLI models get a discovery attempt.

Live caches are scoped to provider, endpoint, and credential/account identity using a digest. A response from an account changed during the request is discarded. Legacy unscoped public provider caches remain readable; unscoped Codex account caches do not. A failed request retains the last good data for the same scope.

## Publication

The hourly `publish-model-catalog.yml` workflow validates sources and publication contracts, then publishes data directly to the dedicated `model-catalog` branch. Application code still goes through normal review. Each publication has an immutable content-addressed snapshot, per-shard checksums, source fetch timestamps/status, and a manifest. Clients fetch the manifest and only the shards for providers with stored credentials; the old master-branch index remains a fallback during migration. Custom catalog mirrors retain the legacy index/shard format.

Source requests have bounded retries and a last-good cache. An invalid schema reuses the source's cached data. A provider that drops more than 25% of at least ten models keeps its cached models while the rest of the source updates; a flat model list that shrinks that much falls back as a whole. Both appear in the workflow summary and the manifest's `sources[]` (`cached` status or a `quarantined` list). Other sources can still update. A first run without a valid source cache fails closed. The final bundle must contain at least 500 models and include Anthropic, OpenAI, Codex, and OpenRouter, with valid limits, inputs, and prices.

For an upstream outage, inspect the workflow summary and manifest source status; the timestamps describe when data was actually fetched. For a legitimate large removal caught by the guard, review the upstream change before invalidating that source's last-good Actions cache. New provider protocols or incompatible capability schemas still require adapter work; discovery cannot grant access an account does not have.

`npm run sync:model-catalog` regenerates the checked-in offline bundle. Normal release builds remain offline and copy that bundle into the CLI package. Deploying the runtime changes requires a new CLI release; the publication workflow becomes active after it lands on the default branch.
