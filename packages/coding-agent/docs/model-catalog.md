# Model catalog maintenance

Routine catalog updates use HTTP requests and deterministic TypeScript normalization, with no AI inference or agent runs.

## Discovery and precedence

The public generator combines models.dev, OpenRouter, Vercel, NVIDIA, OpenCode Zen/Go, and OpenAI's published Codex metadata. Codex model IDs come from that upstream document, not a handwritten list.

At runtime, supported providers also expose live discovery. Codex uses the authenticated account-specific `/codex/models` endpoint, including its client-version query and account header. The client version is resolved from official npm release metadata; only JSON metadata is fetched, never package code. If that lookup fails, discovery uses its last successful version or the bundled fallback.

Provider-supplied capability fields override older published metadata for the same model. Missing fields use existing exact-model metadata or conservative defaults; unknown prices are marked unavailable in the picker. Explicit `models.json` and extension model configuration are applied last. API-specific transport compatibility remains code-owned.

A successful Codex account list controls picker availability, including hidden models. Existing model records remain resolvable for saved sessions and explicit configuration. Codex context limits are route-specific: its default context is not necessarily the maximum advertised for the OpenAI API. Unknown reasoning levels are retained as metadata but are not offered or sent until lunR supports them. Server prompt templates are not imported.

## Refresh and recovery

Interactive startup uses cached or bundled data without catalog network requests. After prompt readiness, an idle poll checks for refreshes; successful automatic refreshes are limited to once an hour per runtime/account configuration, with a one-minute retry delay on failure. Active turns retain their model object, and shutdown cancels the poll. `/refresh` bypasses the freshness gate. The model picker and CLI model listing also request a freshness check; unresolved explicit CLI models get a discovery attempt.

Live caches are scoped to provider, endpoint, and credential/account identity using a digest. A response from an account changed during the request is discarded. Legacy unscoped public provider caches remain readable; unscoped Codex account caches do not. A failed request retains the last good data for the same scope.

## Publication

The hourly `publish-model-catalog.yml` workflow validates sources and publication contracts, then publishes data directly to the dedicated `model-catalog` branch. Application code still goes through normal review. Each publication has an immutable content-addressed snapshot, per-shard checksums, source fetch timestamps/status, and a manifest. Clients fetch the manifest and only the shards for providers with stored credentials; the old master-branch index remains a fallback during migration. Custom catalog mirrors retain the legacy index/shard format.

Source requests have bounded retries and a last-good cache. Invalid schemas and suspicious drops greater than 25% for a source/provider previously containing at least ten models reuse cached data and appear in the workflow summary/manifest. Other sources can still update. A first run without a valid source cache fails closed. The final bundle must contain at least 500 models and include Anthropic, OpenAI, Codex, and OpenRouter, with valid limits, inputs, and prices.

For an upstream outage, inspect the workflow summary and manifest source status; the timestamps describe when data was actually fetched. For a legitimate large removal caught by the guard, review the upstream change before invalidating that source's last-good Actions cache. New provider protocols or incompatible capability schemas still require adapter work; discovery cannot grant access an account does not have.

`npm run sync:model-catalog` regenerates the checked-in offline bundle. Normal release builds remain offline and copy that bundle into the CLI package. Deploying the runtime changes requires a new CLI release; the publication workflow becomes active after it lands on the default branch.
