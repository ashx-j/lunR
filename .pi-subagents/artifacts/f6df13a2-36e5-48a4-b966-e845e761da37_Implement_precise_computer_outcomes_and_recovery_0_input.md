# Task for Implement precise computer outcomes and recovery

Implement computer-use workflow/adapter reliability changes. You are one of exactly two heavy implementation children, isolated worktree C:/Users/ash/Desktop/PROJECTS/lunR-computer-recovery-workflow branch work/computer-recovery-workflow base b216d44. Read C:/Users/ash/Desktop/PROJECTS/lunR/COMPUTER_USE_RECOVERY_PLAN.md fully and your checkout packages/coding-agent/docs/computer-use.md fully. Original investigator is finished. No native driver launch, GUI interaction, provider calls, native payload/pin changes, release, install, push, or PR. Dependencies junction points to parent's new isolated integration worktree, NOT daily driver. Do not alter dependencies or run builds into shared deps. Parent will baseline-build integration deps and do final builds/tests. You may run own focused source tests with shared vitest runner once available.

Exclusive ownership: packages/coding-agent/src/core/computer-use/{workflow.ts,adapter.ts}; tests computer-use.test.ts, computer-adapter.test.ts, computer-image-photon.test.ts; can add one focused contract/helper file in core/computer-use or test if genuinely necessary. Do not edit schemas.ts, policy.ts, extension, docs, AGENTS, package manifests, snapshots. Sibling owns schemas/policy/extension/docs and extension tests. Parent owns integration inventory/AGENTS. Commit your files locally with focused message(s); report commit ids, tests, remaining limits. No review task; implement and verify.

Shared contract agreed BEFORE parallel work:
1. Workflow Result retains content, internal isError, details.observation; adds details.computer:{failed:boolean,workflow:'ready'|'stopped'|'cleanup_unconfirmed'} on all workflow results. Return structured failure results for recoverable validation/native failures, not exceptions; fatal outcomes should preferably also preserve result evidence via this contract. Sibling's extension will RETURN content/details intact, set final isError using computer-scoped tool_result hook, and close only non-ready workflows. Unexpected thrown errors still close. Preserve cleanup uncertainty and original action outcome.
2. computer_hover is WINDOWS ONLY desktop-only schema {desktop:true,foreground:true,observation:string,x:number,y:number}. Workflow maps returned desktop/crop pixels once to native move_cursor {scope:'desktop',x,y}; no delivery_mode unless pinned native schema needs it. Pinned Windows scope window moves overlay only, never real app hover. Refuse non-Windows and window-target calls inside workflow too. Move without button events/focus, fixed ~700ms cancellable dwell, one full desktop post-image, same token/permission invariants and outcomes. No native binary changes. Relevant upstream MoveCursorTool at pinned https://raw.githubusercontent.com/trycua/cua/d8028a7943087ee258dc1b4d19dc12a7cd27669c/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs . Sibling adds schema/tools/policy.
3. computer_apps gains optional include_windows:boolean. Only enable enrichment for query + no pid with include_windows:true; validate other combinations coherently with sibling instructions. Ordinary discovery stays cheap and preserves observation age/token. For enriched named-app matches, at most 5 positive matching PIDs and 50 total windows; if >5 return bounded app identities and narrowing/PID guidance without arbitrary first-PID selection. Nested window metadata per app and explicit truncation/partial-error guidance; preserve native returned PID/owner for UWP host windows, never pretend pid0 is observable. Native list_windows args pid; use existing pagination followup. Sibling schema description will state this. No global unbounded enumeration/fanout.

Implement plan steps 1-5 plus workflow hover from step6: typed precise phase/input/outcome contract, normalize known safe native error codes and recognized plain-text launch error patterns without leaking raw stderr/tree/text; preserve unknown as unknown. Separate adapter preflight from actual MCP request boundary with typed failure evidence (no false no-input for native RPC error). Launch RPC gets bounded operation-specific timeout e.g. 45s within 90s workflow, cancellation immediate; test >15s reply fake timers. Unknown native errors remain uncertain. Settled native refused/partial replies get ONE safe recovery capture if lease/runtime healthy and not aborted; no input retry, no hidden foreground escalation. If image valid issue fresh token and ready; retain outcome+capture failure separately. Fatal cancellation/transport/lease loss closes confirms lease; no recovery capture on these. Local invalid token/coordinates/args leaves healthy workflow ready for fresh observation, old token invalid. Observe attempt invalidates prior; apps does not; launch/input does. Keep 30-second exact target single-use, bounded expiry metadata, partial Unicode counts, repeated-input and unchanged-polling safeguards. Do not have recovery clear repeat/polling history to bypass protections. Launch split from discovery outcome and real callable guidance; pid0 shell reuse handled. Preserve operation evidence on close failure, keep owner on unconfirmed cleanup.

Evidence: installed dev source matches base in owned files; fake-driver confirmed refusal skip image + closes, apps silently clears token, fatal expiry, unconditional failed-launch guidance. Native finish_pixel_uia_attempt can emit background_unavailable effect unverifiable AFTER attempt. Actual user's tool_invocation_failed root cause is unknown; do not claim live native fix. Pure plain native text must not pass unchecked; use stable reasons, known pattern mapping only if grounded.

Tests should exercise actual paths, update existing expectations for intended recovery contract. Child's schemas lack sibling modifications until integration: do not modify owned-by-sibling files to make tests pass; use test-local mocks for new schema where appropriate or report that integration is required. Can coordinate exceptions with supervisor. All tests must scrub inherited PI_SUBAGENT_*/PI_INTERCOM_* if spawning. No new broad framework, no arbitrary comments, no any. Return concise handoff and commits when implemented.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```