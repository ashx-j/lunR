# PR #77 implementation handoff

First writer finished. Second writer can now own verification and remaining build/package/test repairs in `C:/Users/ash/Desktop/PROJECTS/lunR-image-only`.

## Commits and boundaries

- Initial PR/worktree HEAD `a87b3782015cd2c99a21c0065defacd26d75d257` matched fetched `origin/feat/native-computer-use`.
- Fetched master `b57c14889a045e95a15a6a52c6cd39345f4c0f64`.
- Normal merge `990742a571978749f49979eb20cb32c67ca3fa52` preserves both ancestries. Resolved eight conflict files, preserving master's browser, subagent/settings features and three permission modes. Computer observation/release work in read-only; mutation remains blocked. Cron retains isolated contexts and disallows inherited approval channels.
- Repair commit and current HEAD `6263c85d94069c58df9955157a40d63ec5a7c14f`.
- No push, PR merge, publication, daily-driver change, native CuaDriver launch, desktop operation, browser install, or external model request. No settings/credentials changed. Only this explicitly requested handoff was written in the original checkout.
- Working tree has only untracked `.pi-subagents/`; index empty. Keep all its contents private and uncommitted. Master brought its already-tracked Anthropic plan/vendor files through the merge; no private task plan was added.

## Implemented behavior

- Workflow exceptions now carry JSON with a structured code and per-call input state. Pre-dispatch rejection reports `not_dispatched`, explicitly says this call sent no input, and preserves uncertainty about earlier calls. Existing observation state distinguishes unavailable, mismatched token, wrong target, and expired token. Closed workflow reports unavailable without inventing consumed-token history.
- Failed calls invalidate tokens and retain close/lease behavior. Unconfirmed cleanup is reported and retains ownership. Post-dispatch errors remain uncertain. Partial Unicode typing fields and post-image-failure warnings remain intact.
- Conditional guidance requires a fresh exact-target capture before another action including focus, exact token copying, and foreground as the next candidate after `background_unavailable`, not another background shortcut. Fake-driver capture/background-refusal/new-workflow-capture/foreground-text/post-image sequence passes. Hardware foreground typing remains unverified.
- Confirmed raw-text leakage with malformed JSON and AX-like fake replies, then removed the outcome fallback. Bounded structured refusal fields remain.
- Confirmed identical real PNG pixels with different compression bypassed unchanged detection. Fingerprints now hash decoded full-image RGBA plus dimensions. Full captures use opt-in hashing in the existing resize worker decode; crops hash their existing original decode. Default non-computer image processing does not hash. Crop/resize mapping and image budgets remain.
- Tool schema/loaded guidance, computer docs, AGENTS current state/evidence/decision, coverage and both supported-host first-request hashes updated.

## Validation

Own dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`. Verified workspace links and compiler/test executables resolve into this worktree, not original checkout. Node is 26.8.2. Do not use an original-worktree shim.

Passed commands:

- `node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/tui/tsconfig.build.json`, then ai, agent, coding-agent, orchestrator in order. Repeated final sequence used `npm --prefix packages/coding-agent run build` for coding-agent, including Node bundle. Never ran ai's npm build.
- From coding-agent: `node node_modules/vitest/vitest.mjs --run test/computer-use.test.ts test/computer-image-photon.test.ts test/computer-image.test.ts test/computer-extension.test.ts test/computer-cron-factory.test.ts`, final result 82/82.
- `node scripts/check-interactive-first-paint.mjs`, both browser settings and first-turn subagent status/MCP status/LSP/local fetch pass. No actual child task launched by that status fixture.
- Supported host hashes are browser on `4f547e94fdd1fb78d45e490ef3d404099ecaa1f901f0503de15ad2c7852078b7`, off `aba751625ec0818459909c85225b592e2854a4ff908cf77df64cbc35a7b247db`. A private loader captured literal isolated tool inventories/prompts and asserted that removing only computer_load reproduces master's existing hashes. Unsupported-host baseline preserved.
- Correctness lint on changed computer source/tests passes with formatter/assist disabled. Full Biome on changed `image-resize-core.ts` passes. Dense existing computer files retain formatter findings; no mass formatting applied. `git diff --check` and ancestor checks pass.

Expected red-before-green run had 14 failures proving token reporting, refusal recovery, raw leakage, and real-PNG identity problems, with 63 other tests passing.

Expanded run: same five suites plus computer-adapter/install/macos-runtime/runtime/windows-desktop, permissions, plan-mode, image-processing, image-resize-callers. Result 138/139. Sole failure is `computer-install.test.ts`, "serializes extraction and rejects tampered cached helpers without overwriting them". It points PI_PACKAGE_DIR at the source coding-agent package and expects an actual payload archive, which is absent from a fresh source install. Both installRuntime calls report missing optional payload, so zero fulfill instead of one. This test needs scoped fixture/package handling, not runtime download or a real driver launch. I left it for the second writer's package/test scope.

## Artifacts, all local

Under worktree `.pi-subagents/`:

- `computer-red.log`, `computer-green-final.log`, `computer-focused.log`
- `computer-build.log`, `computer-first-request-final.log`, `computer-biome.log`
- `capture-inventory.mjs`, `first-request-browser-on.tools.json`, `first-request-browser-off.tools.json`, corresponding `.prompt.md` files. These are isolated fixture prompts, not the user's configured prompt. Do not publish them.
- `changed-files-including-master.txt` is the complete changed-path list from initial PR head. The merge contains many already-upstream changes; do not treat them as this repair's scope.

Hand-resolved/edited integration paths: AGENTS.md; coding-agent package.json, docs/computer-use.md, builtin-extensions/lunr-computer-use.ts, core/permissions.ts, core/plan-mode.ts, core/settings-manager.ts, modes/interactive/components/settings-selector.ts, modes/interactive/interactive-mode.ts, test/computer-cron-factory.test.ts; scripts/check-interactive-first-paint.mjs. Repair paths additionally include core/computer-use/{workflow,image,schemas}.ts, utils/image-resize-core.ts, and test/computer-{use,image,image-photon,extension}.test.ts. `git show --stat 6263c85` gives the exact repair diff, 12 files, 300 insertions, 35 deletions.

## Next writer

1. Independently verify scoped behavior and integration, especially dispatch reporting/cleanup and pixel identity, without unrelated cleanup.
2. Resolve the installation fixture failure safely. Verify packaging/locks/archive tests as authorized. Production publication stays gated; do not change pins or approvals to force it through.
3. Re-run relevant builds and first-request checks after any source repair. Refresh local snapshots only if their source changes. Update AGENTS/docs to replace pending claims with actual evidence.
4. Commit only intended tracked files, leave index empty, and report exact HEAD to parent. Do not push or merge. Parent handles PR update after verification and awaits user instructions.

Unverified gates remain native platform behavior, foreground typing, cursor animation, measured token savings, standalone/native distribution acceptance, and production approval. Cursor behavior, history retention, runtime pin, and token format were not changed.
