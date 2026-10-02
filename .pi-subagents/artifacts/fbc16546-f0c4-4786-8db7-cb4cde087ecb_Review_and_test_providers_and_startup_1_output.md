Review pinned to clean `origin/master` at `b57c148`. No files changed.

### Findings

- **Medium, incorrect plan usage after an account change.** `packages/coding-agent/src/core/usage-service.ts:119-153` keys cached and in-flight results only by provider. A mocked, source-only repro returned account A's 10% usage for account B without fetching B's quota. `clearPlanUsageCache()` at lines 182-185 also cannot stop an older request from repopulating the cache: after clearing and fetching B's 30%, completion of A's pending request changed B's displayed usage back to 10%. Login, logout, and Grok import call that clear function in `model-runtime.ts:620,632,641`. Incorrect quota can remain visible for the 60-second TTL.
- **Low, stale xAI fixture.** `packages/coding-agent/test/model-runtime-catalog-auth.test.ts:205` expects the fixture's Completions compatibility unchanged. `catalog-merge.ts:40` deliberately applies `withXaiEffortMetadata`, which changes Grok 4.7 to Responses and replaces incompatible fields. The assertion fails on clean master.
- **Low, stale OpenCode fixture.** `packages/ai/test/opencode-catalog.test.ts:107-117` assumes every free model except Muse Spark 1.2 uses Completions. The official shard includes free `muse-spark-1.3-contributor-free` on Responses; the assertion fails on clean master. This is a test-contract mismatch, not proof that the catalog route is wrong.

### Verification and disposition

Clean-worktree fixture runs yielded 115/116 coding-agent assertions and 114/115 AI assertions in the primary provider/catalog sets. Additional startup/auth/catalog tests passed 32/32; Codex OAuth/error tests passed 9 with one skipped; usage/slash tests passed 53/53; focused Fast transport tests passed 8 with 58 filtered out. The two failures above are present on the pinned baseline; the review introduced no failures.

Applicable behavior was checked for #4-5 auth and usage, #8-9 startup, #16-18 xAI/OpenCode catalogs, #19 plan-window selection, #25 cold-start watchdog, #31 Codex Fast and multi-plan usage, and catalog/startup integration carried by #47 and #51. Later listed release PRs were treated as integration checkpoints, not separate feature implementations. Anthropic subscription work, subagent/UI/gateway-owned changes, and publication were excluded. No in-scope `.pi` path or `pi.dev` reference appeared in the scoped provider/auth/usage source search; deferred pi remnants elsewhere were not assessed.

Vitest's coding-agent aliases point at worktree source. No isolated build or compiled-current CLI test was run; junctioned `node_modules` may otherwise resolve the older checkout's `dist`. No credentials, live providers, installs, or network authentication were used.