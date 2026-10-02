## Subagent audit at `b57c148`

I reviewed source and assertions for subagent launch, child permissions, async continuation, supervisor questions, intercom, watchdog startup, and approvals. With inherited subagent and intercom environment variables removed, **292 focused tests passed across 23 suites**. No product files, tests, or staged files changed.

### Findings

- **High: read-only mode permits executable shell commands.** `packages/coding-agent/src/core/plan-mode.ts:117-143,150-160,361-369` blocks a short list of package-manager subcommands and matches Node execution flags only as exact strings. In read-only mode, source-level calls to `gateToolCall("bash", …)` allowed `node --eval=0`, `npm run build`, `pnpm run build`, `yarn run build`, and `npm exec -- echo ok`. These were classified as strings; I did **not** execute the commands. The source calls its Bash heuristic “not a security boundary,” but these allowed forms can run code that writes files.
- **Medium: explicit async singles bypass the large-launch confirmation.** `packages/coding-agent/src/core/large-subagent-launch.ts:13-15,33-35,48-61` excludes `async:true` siblings from the count. A source-level reproduction with three same-turn read-only child calls returned `count:0`, three allowed gate results, and `prompts:0` despite a registered reject handler. This differs from omitted `async`, which now launches asynchronously by default and is counted. No children were spawned in the reproduction.

The existing tests cover ordinary sibling counting and read-only Bash cases, but not those two inputs.

### Coverage and limits

The qualified subagent work represented by #23, #24, #25, #30, #38, #47, #51, #57, #62, #66, #72, and #86 was checked against current source and focused tests. Later qualified release integrations #97, #104, and #112 were assessed as current-tree integration coverage, not as independent live releases. The remaining requested PRs primarily concern subsystems assigned to other reviewers. In the supplied PR dataset, unmerged #2's swarm proposal is superseded by the #23/#24 gate, #28 by #30's completed child cutover, and #61 by #62's schema fix.

An earlier run in the **wrong, dirty checkout** failed one supervisor-continuation test because inherited `PI_SUBAGENT_*` variables routed its fixture request toward the real parent. I notified the parent to ignore that request. The same test passed in the corrected clean worktree with those variables removed; it is not a clean-worktree baseline failure.

Separate pi-remnant note: these modules retain compatible `PI_SUBAGENT_*` and `PI_INTERCOM_*` environment names, `@earendil-works/pi-*` imports, and the `pi-intercom` protocol/pipe name. The `~/.pi/agent/settings.json` reference at `pi-subagents/src/runs/shared/model-fallback.ts:177` is a stale explanatory comment, not an observed runtime write. I found no executable `~/.pi/` path in the inspected subagent/intercom modules. No live provider, installed CLI, daily-driver dist, or published package was tested; junctioned dependencies mean these results do not validate a fresh compiled artifact.