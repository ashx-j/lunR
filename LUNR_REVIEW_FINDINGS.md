# lunR qualified-PR review findings

Date: 2026-09-26. Review target: `b57c148`, local `origin/master`, through PR #115 and version 0.2.24.

## Scope and method

Five heavy subagents reviewed and tested separate areas: subagents/permissions, TUI/settings, providers/startup, gateway/packaging, and imported pi extensions. This report consolidates their evidence. No fixes were applied.

The historical filter selected 68 PRs: 26 Grok-attributed and 42 without identifiable model attribution. PR #96 was added for its outstanding gateway verification. Named models count as attribution even without a provider-qualified slash slug. Anthropic subscription work, including #107 and its portions of release integrations, was excluded at the user's request. Native computer use and unmerged remote hosting were excluded.

The original checkout is a dirty, older branch at `e36432c`. Reviewers were redirected to a clean detached checkout at `../lunR-review-audit`. Its final git status was clean. Existing working files, installed CLI, credentials, services, and GitHub state were not changed. No live provider requests, bot messages, installations, publication, or reboot checks were performed.

Tests target current surviving behavior, not every historical branch. Release PRs share current integration checks. Removed code and superseded unmerged work receive a disposition instead of redundant testing. Source mocks established the defects below; the suite counts alone are not proof of full feature qualification.

The review checkout uses junctioned dependencies. Coding-agent Vitest aliases use source, but other imports can resolve older compiled workspace dependencies. No isolated production build or current compiled-CLI acceptance was performed. Do not interpret this report as a release certification.

## Later-PR reconciliation

Two standard subagents checked every finding against merged history, current source and the live GitHub PR API on 2026-09-26. Stable master remains `b57c148`. PRs #77 and #116 through #119 are open. No finding below has a verified later merged fix. This pass inspected code and tests without rerunning suites; original execution counts remain unchanged.

Two open proposals matter: [#118](https://github.com/ashx-j/lunR/pull/118/files), head `43e06c7`, proposes the OpenCode classification fix; [#119](https://github.com/ashx-j/lunR/pull/119/files), head `09d6705`, partially addresses gateway outbox handling. Both target master. Do not duplicate their proposed work or treat it as shipped.

| Issue | Later-PR status |
| --- | --- |
| R1 | Still present. No later fix found for alternate Node flags or package-script execution. |
| R2 | Still present. Explicit async SINGLE exclusion remains unchanged. |
| R3 | Still present. Provider-only cache keys and stale in-flight completion remain unchanged. |
| R4 | Still present on master. Open #119 drops obsolete notices, but explicitly retains completed results across session changes. The remaining result policy needs a product decision. |
| P1 | Still present. No later removal or cleanup of the process-wide exception handler. |
| P2 | Still present. Both command registrations remain. |
| P3 | All OAuth, MCP client and host identity subitems remain; no live qualification added. |
| P4 | All four tool-description, setup and watchdog branding subitems remain. |
| P5 | Security docs, gallery guidance, all cited examples and migration links remain. |
| P6 | All three dormant comment/path subitems remain; none is promoted to a runtime-write claim. |
| T1 | Still present. Neither later relevant PR repairs the missing runtimeHost mocks. |
| T2a | xAI stale assertion remains untouched. |
| T2b | Reclassified as a medium catalog-generation defect, not merely a stale fixture. Open #118 proposes its fix and focused assertions; not merged. |
| T3 settings | Old .pi settings fixtures remain; #118 does not change these files. |
| T3 resource lists | Existing path/list expectation failures remain; #118 does not address them. |
| T3 footer | Windows separator expectation remains unchanged. |
| T3 model instructions | Remains an unresolved test-contract disagreement, not a confirmed runtime defect. |
| D1 | Still present, including in open #119 despite adjacent gateway documentation changes. |
| Packaging | npm 12 output-shape limitation remains. No release failure or later fix established. |
| Compatibility inventory | Workspace names, pi API names, legacy reads/migration and share viewer remain intentional. Codex originator-header requirement remains unverified. |

Historical replacements such as #28 -> #30, #61 -> #62 and the UI reversals in #68 were already accounted for in the PR disposition table. Changes merged before the reproduced `b57c148` behavior do not close these current findings. Open dev-channel work is not a stable fix.

## Priority findings

### R1. High: read-only Bash classification allows executable command forms

Locations: `packages/coding-agent/src/core/plan-mode.ts:117-160,361-369`.

The command classifier blocks a short list of package-manager operations and exact Node flag strings. Source-level calls to `gateToolCall("bash", ...)` allowed these forms in read-only mode:

- `node --eval=0`
- `npm run build`
- `pnpm run build`
- `yarn run build`
- `npm exec -- echo ok`

The reviewer classified strings only and did not execute those commands. These forms can execute arbitrary code or project scripts that write files. The source explicitly describes its heuristic as not a security boundary, so this is a gap in advertised read-only enforcement, not a claim of an OS sandbox escape.

Existing permission tests do not cover these inputs. A follow-up should define the intended shell contract and test alternate flag syntax and package-script execution against it.

### R2. Medium: explicit async SINGLE calls skip aggregate launch approval

Locations: `packages/coding-agent/src/core/large-subagent-launch.ts:13-15,33-35,48-61`; async default in `src/builtin-extensions/pi-subagents/src/runs/background/top-level-async.ts:24-27`.

Three same-turn SINGLE calls with `async:true` were excluded from the large-launch count. In yolo mode with confirmation enabled and a registered rejecting approval handler, a source reproduction returned count `0`, three allowed gate results, and zero prompts. Omitting `async` for the same trio counted three, although omission now also means async execution.

No children were launched. The explicit and omitted forms should have the same approval behavior. Relevant history includes #23, #24, #47 and later async integration carried by #86.

### R3. Medium: provider-only usage cache mixes account results

Locations: `packages/coding-agent/src/core/usage-service.ts:119-153,182-185`; cache clearing callers in `src/core/model-runtime.ts:620,632,641`.

Cached and pending requests are keyed only by provider. A mocked Kimi source reproduction returned account A's 10% usage for account B with only one fetch. A second reproduction cleared the cache, fetched B's 30%, then completed A's older pending request. Subsequent B usage reverted to 10%.

Login/logout cache clearing does not invalidate outstanding completions. Wrong quota can remain visible for the 60-second TTL, including across account changes. No credentials or network requests were used. Follow-up coverage should exercise account identity and stale in-flight completion after invalidation. Relevant PRs include #5, #19 and #31.

### R4. Medium: queued gateway notice can cross a session change

Locations: `packages/coding-agent/src/gateway/presenter.ts:81-109,116-118`.

The outbox stores a session epoch but retry delivery does not check it. A fake-adapter reproduction failed the first send, invalidated the chat's dialogs and rebound its key to a new project/session. The retry then delivered `OLD SESSION result` to the new conversation. Observed attempts: two; delivered messages: one stale result.

No bot or network was used. This is a current #96 lifecycle gap despite its passing ownership/handoff fixture tests.

Open [#119](https://github.com/ashx-j/lunR/pull/119), head `09d6705`, partially addresses it. Its `presenter.ts:179-186` discards obsolete `kind:"notice"` entries, but `kind:"result"` delivery at lines 188-205 checks chat identity and authorization rather than session/project identity. Its test explicitly preserves completed results after a session change. Thus obsolete notices have a proposed fix, while same-chat results after project/session rebinding remain an intentional proposal requiring a product decision, not automatically another implementation defect. None of #119 is merged into this report's baseline.

## Separate category: imported pi extensions and naming remnants

### P1. High: imported LSP extension swallows uncaught exceptions and leaks handlers

Locations: `packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/index.ts:143-156,616-622`.

Each factory invocation installs a process-wide `uncaughtException` listener. Shutdown does not remove it. The handler logs non-EPIPE exceptions rather than terminating when there were no previous listeners.

Source-factory reproduction observed listener counts `0 -> 1 -> 1 after shutdown -> 2 after a second factory`. A separate subprocess threw a sentinel exception, logged `[LSP] Uncaught exception: Error: isolated sentinel`, printed `survived-uncaught`, and exited with code 0. The parent process did not throw.

This changes process-wide failure semantics and can leave the runtime running after an unexpected exception. Reloads also accumulate handlers and their captured previous listeners. Existing LSP startup tests pass without exercising this path.

### P2. Medium: two imported extensions register `/chain-prompts`

Locations:

- `src/builtin-extensions/pi-prompt-template-model/index.ts:1778`
- `src/builtin-extensions/pi-subagents/src/slash/prompt-workflows.ts:298`
- Resolver: `packages/coding-agent/src/core/extensions/runner.ts:579-608`

The first two paths are relative to `packages/coding-agent`. Mock registration through both source modules and the actual runner produced `chain-prompts:1` and `chain-prompts:2`. `getCommand("chain-prompts")` returned null. The advertised plain command is therefore ambiguous/unavailable when both are registered.

### P3. Medium: MCP OAuth/client identity still says Pi

Under `packages/coding-agent/src/builtin-extensions/pi-mcp-adapter/`:

- `mcp-oauth-provider.ts:119-135` defaults registration to `Pi Coding Agent` and the upstream adapter URL.
- `server-manager.ts:243,340` and `host-html-template.ts:169` retain pi client/host identity.

These are externally visible identities, unlike internal compatibility identifiers. This finding is source-inspected, not live OAuth-qualified. No registration request was made.

### P4. Low: agent-facing text and setup UI retain old branding

Under `packages/coding-agent/src/builtin-extensions/`:

- `pi-mcp-adapter/direct-tools.ts:146`: `Non-MCP Pi tools`.
- `pi-intercom/index.ts:1444-1458`: `another pi session`.
- `pi-mcp-adapter/mcp-setup-panel.ts:437-491`: calls the lunR agent directory Pi.
- `pi-subagents/src/watchdog/review.ts:208`: identifies the session as Pi.

If tool descriptions are corrected, update affected coverage and prompt/tool snapshots according to repository policy.

### P5. Low: shipped examples and migration guidance point at upstream paths

Under `packages/coding-agent/`:

- `docs/security.md:35-47`: instructs users to run `pi`.
- `docs/packages.md:133`: promotes the pi.dev gallery.
- `examples/sdk/06-extensions.ts:8-9`, `examples/extensions/commands.ts:8`, and `examples/extensions/claude-rules.ts:15`: old `~/.pi/agent` or pi invocation guidance.
- `src/migrations.ts:13-16,313-314`: emits upstream pi-mono documentation links in migration warnings.

These are documentation defects, not evidence that active runtime configuration is being written to `~/.pi`.

### P6. Low: dormant source comments retain pi installation instructions

`pi-ollama-cloud/index.ts:8`, the unregistered `pi-lsp-extension/bemol-extension/index.ts:8`, and `pi-subagents/src/runs/shared/model-fallback.ts:177` retain old path guidance. All are under `packages/coding-agent/src/builtin-extensions/`. The model-fallback reference is a comment, not a runtime write.

### Active imported-extension inventory

`packages/coding-agent/src/builtin-extensions/index.ts:33-58` registers 19 factories.

| Loading | Registered names |
| --- | --- |
| Light | simple-pi-memory, pi-tps, ashxj-tui, ashxj-spinners, ashxj-thinking, lunr-local-providers, lunr-todos, lunr-plan-tools, lunr-skill-creator |
| Deferred | pi-ollama-cloud, narumiruna-pi-goal, lunr-cron, pi-intercom, pi-prompt-template-model, pi-subagents, pi-web-access, lunr-browser, pi-lsp-extension, pi-mcp-adapter |

The pi-named directories and goal extension entered with the pi-derived baseline. This review did not establish exact external upstream revisions for every vendored directory. Bemol is tracked but absent from the active built-in roster.

### Intentional compatibility or unresolved protocol requirements

Do not mechanically rename these:

- `@earendil-works/pi-*` workspace imports, extension callback variable `pi`, package metadata key `pi`, and `PI_*` environment contracts.
- The `pi-intercom` protocol/pipe name.
- MCP's legacy project `.pi/mcp.json` fallback when `.lunr/mcp.json` is absent. Active writes use the lunR path. See `pi-mcp-adapter/config.ts:113-119,198-259`.
- `src/migrations.ts:332-401` deliberately copies selected old `~/.pi` state.
- `/share` retains a documented pi.dev viewer default at `src/config.ts:172-177`, documented in `docs/usage.md:173`. It is not a catalog or installer request. No share was performed.
- `pi-web-access/openai-search.ts:349` sends `originator: "pi"` on the Codex route. Its protocol requirement remains unverified; do not rename it without qualification.

No executable `~/.pi` path was found in the inspected subagent/intercom modules. Active path resolvers inspected by the pi reviewer default to `.lunr`. This is not a claim that every possible runtime path has been exercised.

## Test and documentation findings

### T1. Medium: two image-paste tests crash before exercising submission

`packages/coding-agent/test/image-paste-markers.test.ts:121,152` creates prototype-based `InteractiveMode` mocks without the newly required `runtimeHost`. Both tests crash at `src/modes/interactive/interactive-mode.ts:3049`, before testing chip submission or `/paste-image`.

This establishes broken coverage, not a production paste failure. Repair the mock, then reassess the assertions and behavior.

### T2a. Low: xAI fixture disagrees with current catalog rules

`packages/coding-agent/test/model-runtime-catalog-auth.test.ts:205` expects raw xAI Completions compatibility, while `src/core/catalog-merge.ts:40` deliberately applies the Grok Responses effort overlay. This remains a stale assertion on the pinned baseline. Open #118 does not modify it.

### T2b. Medium: OpenCode generation hardcodes one Muse Spark version

Correction to the initial report: `packages/ai/test/opencode-catalog.test.ts:107-117` calls `opencodeFreeModelApi`; it is not the source of the hardcoded classification. The production generation helper at `packages/ai/scripts/opencode-catalog.ts:89-92` recognizes only `muse-spark-1.2-contributor-free` as Responses. The catalog already includes `muse-spark-1.3-contributor-free` on Responses, so generation can misclassify newer matching IDs.

Open [#118](https://github.com/ashx-j/lunR/pull/118), head `43e06c7`, generalizes the production rule to `muse-spark-*-contributor-free` and adds assertions for versions 1.2, 1.3, 2.0 and catalog rows. This is a proposed fix, not merged work. The reconciliation inspected its diff without executing it. No live routing failure was tested.

### T3. Existing or unresolved fixture failures

- Seven project-settings assertions still use `.pi/settings.json`, including `settings-manager.test.ts:19,284,300-392,404,533` and settings-manager-bug fixtures. Runtime uses `.lunr` at `src/core/settings-manager.ts:288`.
- Twelve `interactive-mode-status` failures retain old resource path/list expectations.
- `test/footer-width.test.ts:85` expects a slash path on Windows.
- `test/model-instructions.test.ts:135` expects the intercom bridge disabled under assumptions that differ from current controls. Treat this as unresolved test-contract disagreement, not a confirmed runtime regression.

### D1. Low: gateway upload directory is documented incorrectly

`packages/coding-agent/docs/features.md:146` says `.lunr/uploads/`; `src/gateway/agent-bridge.ts:572` writes `.lunr/gateway-uploads/`.

### Packaging limitation

The local npm 12 `npm pack --json` shape is keyed rather than the array expected at `scripts/publish.mjs:182`. The documented Node 22/npm 10 publication workflow is different. This is a local validation compatibility limitation, not a reproduced release failure. No publication or package build was attempted.

## Test execution summary

Counts below are separate executions and may overlap. Do not add them as a unique-test total.

| Area | Source/fixture result |
| --- | --- |
| Subagent/permission/lifecycle | 292 passed across 23 suites: batches of 154, 77 and 61 |
| TUI node tests | 390 passed, covering editor, mouse, pinned scrolling/resizing, renderer, box, keys and image handling |
| Clean focused coding-agent UI | 198 passed across 19 files |
| Broader UI/settings | 246 passed, 21 failed; failures comprise 12 resource fixtures, seven settings fixtures, two paste mocks |
| Additional UI tests | 162 passed, two failed: Windows footer path and model-instructions expectation |
| Primary provider/catalog coding-agent | 115 passed, one stale xAI fixture failed |
| Primary provider/catalog AI | 114 passed, one OpenCode classifier/catalog mismatch failed; reclassified as T2b |
| Additional startup/auth/catalog | 32 passed |
| Codex OAuth/error | Nine passed, one skipped |
| Usage/slash | 53 passed |
| Focused Fast transport | Eight passed, 58 filtered out |
| Gateway/session/approval/cron/permission | 328 passed across 22 suites |
| Packaging fixtures | 23 passed across three suites |
| LSP startup/prompt templates | 104 passed |
| Static packaging checks | Shrinkwrap, installer lock, workflow publication policy, relative-import and lockfile checks passed |

Additional isolated reproductions established R1 through R4 and P1/P2. R1 classified command strings without running them. R2 spawned no children. R3/R4 used fake adapters, not live accounts or bots. P1's uncaught exception occurred only in a separate subprocess.

An initial subagent test run accidentally ran in the older checkout with inherited supervisor variables. It emitted a fixture question to the real parent and failed one continuation test. Reviewers corrected the checkout and scrubbed `PI_SUBAGENT_*`/`PI_INTERCOM_*` variables; clean reruns passed. That initial failure is excluded from the baseline findings. Future fixture runs must isolate these environment variables.

## Complete qualifying-PR disposition

Each row accounts for a qualifying PR or contiguous group. Source-tested means relevant current tests ran, not that every historical requirement received end-to-end acceptance. PR descriptions are at `https://github.com/ashx-j/lunR/pull/<number>`.

| PRs | Current disposition |
| --- | --- |
| #1 | Historical lockfile repair; current lock/package checks passed. Historical audit reported zero vulnerabilities, but no fresh network vulnerability audit was run. |
| #2 | Closed unmerged; old swarm proposal superseded by current #23/#24 behavior. Current gate tested; R1/R2 remain. |
| #3 | Manual-only npm-audit workflow change; packaging/workflow inspection, not a runtime feature test or scheduled audit execution. |
| #4, #5 | Auth/refresh/usage fixtures exercised. No live xAI credential rotation; R3 and T2 apply. |
| #6, #7 | Model-tier toggle and scrolling behavior covered by focused source tests. |
| #8, #9 | Startup/deferred-loading fixtures exercised. No compiled-current cold-start qualification. |
| #10, #11, #12, #13, #14, #15 | Tool layout, scrolling and thinking-command UI covered by current focused tests. |
| #16, #17 | xAI effort/catalog/refresh behavior covered by provider fixtures; stale xAI assertion recorded as T2. |
| #18 | OpenCode and TUI portions exercised; generation classification defect T2b has a proposed fix in open #118. |
| #19 | Current footer/render/click/undo subset and usage behavior exercised; R3 applies. Not every product-UX flow was manually verified. |
| #20 | Behavior presets removed by #32; no obsolete feature retest. |
| #21 | Historical release integration; surviving behavior tested through current suites, no old release install. |
| #22 | Image-chip/UI/provider subsets exercised; T1 blocks two submission assertions. |
| #23, #24 | Current approval/gateway/cron/permission behavior exercised; explicit async gap R2 remains. |
| #25 | Watchdog/cold-start tests exercised. |
| #26 | Current prompt/tool behavior inspected through subsystem checks; no independent complete base-prompt snapshot replay. Pi text findings P4 apply. |
| #27 | Shipped-doc review found remaining pi guidance P5. No npmjs rendering check. |
| #28 | Closed unmerged; superseded by #30. |
| #29 | Footer cache-hit rendering/settings covered by focused source tests. |
| #30 | Current generic-child executor and lifecycle tested. |
| #31 | Fast transport, usage and slash fixtures exercised; R3 applies. Live Fast and multiple real plans remain unverified. |
| #32 | Current settings/migration portions exercised; old preset behavior intentionally gone. Stale path fixtures T3 remain. |
| #33 | Historical release checkpoint; current integration/package checks only. |
| #34, #35 | Context labels and skill tags covered by focused UI tests. |
| #37 | Historical release checkpoint; current integration/package checks only. |
| #38 | Current tier/model row behavior source-tested alongside later display revisions. |
| #47 | Current settings, permission and startup integration exercised; R1/R2 apply, some UI paths source-review only. |
| #51 | Current startup/subagent integration exercised; no historical release rebuild. |
| #52 | Focused current UI tests exercised surviving behavior. |
| #53 | Rail-removal behavior superseded by #68; restored rails tested instead. |
| #54, #55 | Current UI source/test evidence partial; no individual live acceptance claim. |
| #56 | Focused current UI tests exercised surviving behavior. |
| #57 | Current executor tests plus partial UI evidence. |
| #58, #59 | Focused current thinking/editor/UI tests exercised surviving behavior. |
| #60 | Empty-chat context card removed by #68; no obsolete card retest. |
| #61 | Closed unmerged; superseded by #62. |
| #62 | Current schema/child-launch tests exercised. |
| #63, #64 | Release and documentation for schema fix; #62 current tests and package checks substitute for historical retest. |
| #66 | Current integration and source fixtures; no compiled historical release check. |
| #67 | Publication documentation; no runtime test needed. |
| #68 | Restored rails/current empty-chat UI tested. |
| #69 | Release integration covered through current fixtures/package checks. |
| #70 | Publication documentation; no runtime test needed. |
| #72 | Current continuation, supervisor and intercom fixtures tested. |
| #86 | Current async/subagent integration tested; R2 remains despite broader passing suites. |
| #87 | Publication documentation; no runtime test needed. |
| #97 | Current release/package and gateway fixtures exercised, not installed-release acceptance. |
| #98 | Publication documentation; no runtime test needed. |
| #104 | Current combined UI/subagent/package checks, no historical release install. |
| #105 | Publication documentation; no runtime test needed. |
| #112, #113 | Current integration/package/source checks only; all Anthropic portions excluded. |
| #114, #115 | Publication/status documentation; no runtime test needed. |
| #96, additional scope | Ownership/handoff/gateway fixtures exercised; R4 remains. Live bot/service acceptance still pending. |

## Remaining acceptance gaps

- Live Codex Fast and usage with multiple stored subscription plans.
- Real Telegram/Discord handoff, approvals and native startup-service installation/reboot.
- Physical clipboard interaction and simultaneous live output, resize and scrolled-chat acceptance.
- Isolated current production builds, packaged CLI and fresh-install checks.
- Cross-platform runtime behavior beyond this Windows source-test environment.
- Full individual manual acceptance for PRs marked partial above.
- Anthropic subscription checks intentionally excluded, not blocked work to resume automatically.

Live checks need separate authorization and available accounts/hardware. Passing source fixtures does not close these gaps.

## Evidence artifacts

Agent reports remain local under `.pi-subagents/artifacts/`:

- `3f05683b-cfd6-4d69-9fb4-c7fc34849261_Review_and_test_subagent_lifecycle_and_permissions_output.md`
- `fbc16546-f0c4-4786-8db7-cb4cde087ecb_Review_and_test_TUI_and_settings_0_output.md`
- `fbc16546-f0c4-4786-8db7-cb4cde087ecb_Review_and_test_providers_and_startup_1_output.md`
- `fbc16546-f0c4-4786-8db7-cb4cde087ecb_Review_and_test_gateway_and_packaging_2_output.md`
- `fbc16546-f0c4-4786-8db7-cb4cde087ecb_Audit_pi_extensions_and_naming_remnants_3_output.md`
- `a9ed3651_Audit_pi_extensions_and_naming_remnants_output.md`, including exact isolated P1/P2 reproduction commands.
- `0cf6c549-864b-4e91-aba7-36e7c7be064e_Check_later_fixes_for_runtime_and_test_findings_0_output.md`, reconciliation of R1-R4, T1-T3 and packaging against later PRs.
- `0cf6c549-864b-4e91-aba7-36e7c7be064e_Check_later_fixes_for_pi_remnants_and_documentation_1_output.md`, reconciliation of every pi finding, compatibility item and D1.

Matching `_transcript.jsonl` artifacts preserve tool invocations and results where emitted by the runner. UI logs are in the local temporary directory as `lunr-ui-{tui,code,extra,focused,green}-test.log`. No private material was uploaded.
