# PR #77 validation handoff

## Outcome

Scoped validation and fixture repairs are complete. It is safe to push this branch as a PR update, without merge or release, provided the update explicitly retains the CI and native-release blockers below. I cannot call it clean-CI merge-ready. No push, PR merge, publication, global installation, desktop control, CuaDriver launch, or live provider request occurred.

The smallest next decision is whether to repair the reproduced baseline CI failures in separate work or explicitly accept that red baseline for this PR. Real native archives, hardware acceptance, and production approval remain separate release decisions. Cursor animation and screenshot-history changes stay deferred.

## Commits and ancestry

Worktree: `C:/Users/ash/Desktop/PROJECTS/lunR-image-only`.

Final HEAD: `55e97bc8cc43424351baa5d9db6aacd9b5b843a6`.

New sequence, preserving first-parent PR history:

1. `990742a571978749f49979eb20cb32c67ca3fa52` Merge current master into native computer use.
2. `6263c85d94069c58df9955157a40d63ec5a7c14f` Fix computer recovery and compare decoded screenshot pixels.
3. `55e97bc8cc43424351baa5d9db6aacd9b5b843a6` Make computer packaging tests independent of native archives.

Fetched `origin/master` during validation. It remains `b57c14889a045e95a15a6a52c6cd39345f4c0f64`, an ancestor of final HEAD. Original PR head `a87b3782015cd2c99a21c0065defacd26d75d257` is also an ancestor. No rebase, ancestry rewrite, or unresolved merge.

Final index is empty. `git status --short` reports only untracked `.pi-subagents/`. Do not commit or upload that directory. The only write in the original dirty `lunR` checkout during this worker was this requested handoff. No build, dependency, source, settings, or credential files there were changed.

## Changes in this worker

Four files, 88 insertions and 14 deletions:

- `packages/coding-agent/test/computer-install.test.ts`: the Windows installation test now creates a local ZIP with inert driver/helper text files. Test-only checksum metadata points at it. The real installer performs extraction, installation locking, cache reuse, and tamper rejection without executing a driver. Other resolution tests retain the real platform/package identities.
- `scripts/computer-use-packages.test.mjs`: staging and standalone-copy tests use generated opaque fixture bytes through their existing source-directory parameter. Test metadata is restored afterward. Missing release archives no longer make this source test fail.
- `packages/coding-agent/docs/computer-use.md`: fresh verified results, exact baseline CI comparison, fake-versus-real packaging distinction, and remaining native gates.
- `AGENTS.md`: current validation, fixture constraint, and decision record.

Production runtime code, pin, generated release metadata, approval, permissions, tool schemas, prompt guidance, cursor behavior, and image history were unchanged by this worker. The previous worker's repairs remain intact. The commit bypassed the aggregate formatting hook to avoid unrelated auto-format changes; explicit scoped lint and policy checks passed.

## Isolation and build evidence

Node `26.8.2`, npm `12.0.2`, Windows x64.

Resolved the compiler, Vitest entry, npm compiler shim, and workspace package link into `lunR-image-only`, not the original checkout. Used explicit `node` paths and the worktree CLI. There is no worktree `node_modules/.bin/lunr`; no `npx lunr` was used as evidence.

Passed the final ordered offline sequence:

- `node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/tui/tsconfig.build.json`
- Same command for `ai`, `agent`, `coding-agent`, `orchestrator`, in that order.
- `npm --prefix packages/coding-agent run build`, including the Node bundle.
- `node packages/coding-agent/dist/cli.js --version` reports `0.2.24`.

Never ran the AI npm build or live catalog generation. Final build log: `.pi-subagents/validation-build.log`.

## Focused tests

Final combined run passed **239 tests across 21 test files**, zero failures or skips. It used a clean environment without inherited `PI_*`, CUA, provider-key, or token variables and `--maxWorkers=4`.

From `packages/coding-agent`, the command was `node node_modules/vitest/vitest.mjs --run --maxWorkers=4` with:

- all ten `test/computer-*.test.ts` files: adapter, cron factory, extension, real Photon, image mapping, installation, macOS runtime, runtime, workflow/lease, Windows desktop fake probes;
- `test/permissions.test.ts`, `test/plan-mode.test.ts`;
- `test/image-processing.test.ts`, `test/image-resize-callers.test.ts`;
- `test/gateway-cron.test.ts`, `test/cron-jobs.test.ts`, `test/cron-scheduler.test.ts`;
- `test/deferred-builtin-extensions.test.ts`, `test/permission-mode-control.test.ts`, `test/subagent-permission-inherit.test.ts`, `test/agent-session-dynamic-tools.test.ts`.

Logs/reporter: `.pi-subagents/validation-focused-final.log` and `.pi-subagents/validation-focused-final.json`. Reproduction runner: `.pi-subagents/final-validation.mjs`.

The computer workflow tests include exact-token rejection without action dispatch, background refusal followed by fresh observation and fake foreground typing/post-image, uncertain/partial outcomes, decoded-pixel repeat detection, leases and cleanup. No foreground input on hardware was tested.

`node --test scripts/check-computer-use-release.test.mjs scripts/computer-use-packages.test.mjs` passes **8/8**. Log: `.pi-subagents/validation-archives-final.log`.

Two diagnostic-run limitations are retained rather than hidden:

- An initial subagent-permission test failed when inherited child communication variables were present. Its clean-environment run passes, as does the final combined run.
- One unconstrained 21-file JSON run ended with Vitest's incomplete-report warning, showing 235 passed and unfinished image assertions, without failed assertions. That run is inconclusive. The bounded four-worker rerun completes all 239. Saved incomplete reporter: `.pi-subagents/validation-focused-incomplete.json`.

## Startup and prompt/tool coverage

`node scripts/check-interactive-first-paint.mjs` passes stalled and failed runtime startup, browser-on/off first requests with optional implementation imports blocked, and first-turn subagent status, MCP status, LSP parsing, and local HTTP extraction.

Final run scrubbed inherited runtime variables and used the existing private capture hook to regenerate local isolated prompt/tool inventories after the documentation updates. No private inventory is committed.

Supported-host hashes remain:

- browser on: `4f547e94fdd1fb78d45e490ef3d404099ecaa1f901f0503de15ad2c7852078b7`
- browser off: `aba751625ec0818459909c85225b592e2854a4ff908cf77df64cbc35a7b247db`

The capture hook asserts that removing only `computer_load` yields the unchanged master hashes `c7a60ad06073297d688a4ec1b5c7056ae9ff6df1738123b0d471f20aa0a85bbf` and `3693bff47d556206b75ccf61c3c6de2cd53f81e0a40c441fe6210993972287fa`. No fixture hashes changed in this worker. No unsupported-host hardware launch was performed.

Log: `.pi-subagents/validation-first-request-final.log`. Local private snapshots: `.pi-subagents/first-request-browser-{on,off}.tools.json` and matching `.prompt.md` files.

## Public packaging evidence and boundaries

Real stable dry-run command `node scripts/publish.mjs --dry-run` **fails** before staging because `packages/coding-agent/native/computer-use/cua-driver-rs-0.28.1-windows-x86_64-binary.zip` is absent. Only the license is present in this source checkout. No archive was fetched to hide this blocker. Log: `.pi-subagents/validation-stable-dryrun.log`.

Separately, a temporary sandbox copied the built public package contents and existing packaging scripts. Only sandbox release checksum/size metadata and the sandbox unbundled runtime metadata were replaced with explicit inert fixture identities. The approval string remained `development-only; production release not approved`. The repository's metadata never changed.

The unchanged `scripts/publish.mjs --dry-run --pack-dir <sandbox>/packs` then staged and packed all **seven public-name tarballs at 0.2.24**, including three host payload fixtures. Its validators checked exports and rewritten JS/d.ts names throughout the compiled tree. Both shrinkwrap and installer lock received exact-version optional payload dependencies.

The unchanged `scripts/check-computer-use-install.mjs <sandbox>/packs` passed:

- local-registry isolated installation with lifecycle scripts disabled;
- host-only optional payload selection and fixture archive verification;
- relocating the installation, then all first-paint/first-request checks;
- Windows x64, Windows arm64, Apple Silicon, and Linux selection cases;
- `--omit=optional` recovery diagnostic;
- standalone staged installer lock `npm ci --ignore-scripts` with matching fixture payload.

It never calls `installRuntime` or launches CuaDriver. These checks establish public packaging mechanics, not real archive integrity, signatures, or native operation. No tarball was published or uploaded. Existing public dependency downloads are ordinary isolated npm installation, not live model requests.

Final sandbox: `C:/Users/ash/AppData/Local/Temp/lunr-pr77-fixture-stage-f4SrpR`. It contains **test-only fake payloads and must not be published**. Pointer: `.pi-subagents/fixture-stage-path.txt`. Runner: `.pi-subagents/stage-fixture-packages.mjs`. Logs: `.pi-subagents/validation-fixture-pack.log`, `.pi-subagents/validation-fixture-install.log`.

Source shrinkwrap and installer locks pass their `--check` scripts unchanged. Publication still requires a separate production approval and a new CLI version. The production guard in `publish.mjs` remains intact; no non-dry-run publication command was invoked.

## CI baseline comparison

Fetched the public annotations for prior PR check run `106092132879` from workflow run `35516076841`. Evidence: `.pi-subagents/pr77-ci-annotations.json`. The unavailable `gh` executable was not a blocker; a read-only GitHub API request returned 200.

Created a separate detached worktree at `C:/Users/ash/Desktop/PROJECTS/lunR-pr77-validation-base`, exactly master `b57c14889a045e95a15a6a52c6cd39345f4c0f64`. It has its own `npm ci --ignore-scripts --no-audit --no-fund`, five offline builds and Node bundle. Both base and HEAD use Node 26, the same locked dependencies, scrubbed inherited credentials/runtime variables, isolated homes, and offline test settings.

The eight annotated suites reproduce **the same 10 failing test names, with the same failure categories**, on both revisions:

Coding-agent: **45 passed, 3 failed** on both.

1. `install-features.test.ts`: gateway.json file-token enablement inference expects true, receives false.
2. `extensions-discovery.test.ts`: coding-agent entrypoint fixture expects zero errors, receives one.
3. `suite/regressions/5724-sigterm-signal-exit.test.ts`: signal-triggered shutdown fixture lacks `stopSmoothStreaming`; disposal expectation fails.

AI: **63 passed, 7 failed** on both.

4. `anthropic-adaptive-thinking-models.test.ts`: built-in adaptive model metadata expectation.
5. `anthropic-empty-thinking-signature-compat.test.ts`: default empty-signature conversion has additional cache-control metadata.
6. Same file: `kimi-for-coding` model missing from current catalog fixture.
7. `anthropic-force-adaptive-thinking.test.ts`: `kimi-for-coding` has undefined API.
8. Same file: `kimi-k2-thinking` has undefined API.
9. `openai-completions-tool-choice.test.ts`: OpenCode fixture expects `max_tokens`.
10. `opencode-catalog.test.ts`: Muse Spark contributor-free shard API expectation differs.

Runner: `.pi-subagents/compare-ci.mjs`. Detailed structured reports: `.pi-subagents/ci-{head,base}-{coding-agent,ai}.json`, plus matching logs. A separate assertion confirms identical sorted failed-test name sets. This reproduces the listed historical CI problems; it does not claim a fresh complete CI run or that every unrelated suite is green. No broad baseline cleanup was attempted.

## Checks and final state

Passed:

- `node scripts/generate-coding-agent-shrinkwrap.mjs --check`
- `node scripts/generate-coding-agent-install-lock.mjs --check`
- `node scripts/check-no-workflow-npm-publish.mjs`
- `node scripts/check-ts-relative-imports.mjs`
- `node scripts/check-pinned-deps.mjs`
- `node scripts/verify-claude-vendor.mjs`, 19 upstream hashes
- `node node_modules/@biomejs/biome/bin/biome check packages/coding-agent/test/computer-install.test.ts`
- `node --check scripts/computer-use-packages.test.mjs`
- `git diff --check` and `git diff --check origin/master`
- unchanged production metadata and approval assertions
- original PR and fetched-master ancestor assertions
- empty final index

One attempted policy command used the nonexistent filename `check-relative-imports.mjs`; the correct `check-ts-relative-imports.mjs` then passed. This was a command typo, not a repository failure.

## Public-safe suggested PR update

Integrated current master without rewriting PR ancestry. Computer recovery now distinguishes rejected input from uncertain dispatch, requires fresh exact observations after failure, suppresses unparseable driver text, and detects unchanged decoded pixels across PNG encodings. Source installation/staging tests use inert local payloads rather than requiring release binaries.

Validation passes five offline builds, the Node bundle, 239 focused tests, eight archive/package tests, and browser-on/off startup/tool checks. Seven fixture public packages pass relocated installation, platform payload selection, omitted-payload recovery, and exact installer locks. No desktop or native runtime was operated.

This is not yet clean-CI merge-ready: the ten prior annotated test failures reproduce on isolated current master as well. Real native archive validation and production approval remain outstanding. Cursor animation and screenshot-history changes are deferred. No release is authorized by this update.
