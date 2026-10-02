# Task for Implement rich tool results and desktop hover contracts

Implement computer-use tool contract/lifecycle and Windows desktop-hover exposure. You are second of exactly two heavy implementation children, isolated worktree C:/Users/ash/Desktop/PROJECTS/lunR-computer-recovery-tools branch work/computer-recovery-tools base b216d44. Read C:/Users/ash/Desktop/PROJECTS/lunR/COMPUTER_USE_RECOVERY_PLAN.md and checkout packages/coding-agent/docs/computer-use.md fully. Original investigator finished. No native driver launch/GUI/provider calls/native payload changes/releases/installations/push/PR. Shared node_modules junction goes to fresh integration checkout, do not change dependencies or build shared packages.

Exclusive ownership: packages/coding-agent/src/core/computer-use/{schemas.ts,policy.ts}; packages/coding-agent/src/builtin-extensions/lunr-computer-use.ts; packages/coding-agent/test/computer-extension.test.ts and new focused extension agent-loop test only if needed; packages/coding-agent/docs/computer-use.md. May update directly relevant permission/child-tool coverage files only where hover registration requires it, tell parent exact paths. DO NOT edit workflow.ts, adapter.ts, computer-use.test.ts, computer-adapter.test.ts, computer-image-photon.test.ts, AGENTS, manifests, first-paint snapshot. Sibling owns runtime/workflow/tests. Parent integrates, builds, first-request inventory, AGENTS. Commit locally only your files in focused commits and report ids/tests/limits.

PREAGREED cross-child contract:
1. Workflow execute Result retains content/internal isError/details.observation and adds details.computer:{failed:boolean,workflow:'ready'|'stopped'|'cleanup_unconfirmed'} to all workflow results. Recoverable failures return structured result, not throw. Your extension should return content/details intact even when failed; use existing tool_result hook scoped to computer tools and safe detail marker to return {isError:true}. Current agent loop ignores result-level isError, so simply returning workflow isError isn't sufficient. MCP adapter error-signal.ts uses analogous existing hook. Do not redesign agent API. Keep a ready workflow through recoverable failures. Stop/discard only non-ready workflow; preserve original outcome if cleanup is unconfirmed rather than replacing evidence with another exception. Unexpected throws still safely close. Session/settings/agent_end shutdown, generation guards, startup laziness, child exclusion, image model requirements remain.
2. New computer_hover schema WINDOWS ONLY desktop-only {desktop:true,foreground:true,observation:string,x:number,y:number}. Mutation, blocked in read-only and when foreground disallowed, parent-only. Native pinned move_cursor desktop uses SetCursorPos, no real window/background hover (window scope is synthetic overlay, --no-overlay active). Sibling implements mapping, 700ms cancellable dwell and one full desktop post-image. Your schema/description/register/active roster must expose hover only on Windows supported host, no PID/window_id/dwell params, explain real cursor foreground movement/no click. Ensure stable existing tool coverage OTHER_PLATFORMS and lifecycle allowlist/child exclusion accurately reflect conditional registration. Do not expose unsupported hover merely hidden then activatable. Existing computerSchemas/COMPUTER_TOOLS may list all capabilities but registration and loaded roster select actual supported tools; preserve equality tests sibling will integrate. Discuss any shared contract adjustment via supervisor.
3. computer_apps optional include_windows:boolean. Requires query and no pid if true. Description: bounded window enrichment for named app lookup, max5 running matched PIDs/max50 window rows, >5 asks narrow/PID rather than arbitrary selection; ordinary query just app discovery stays cheap. Sibling implements nested windows plus explicit partial/truncation metadata and native PID preservation for UWP. New schema should describe query collection scope honestly. Launch remains {name} no observation token. Launch description no longer promises a returned window; outcomes guide apps/query/pid then observe.

Implement extension-level recovery and rich error propagation tests, INCLUDING an actual agent-loop or AgentSession seam so model-facing failed result retains image+details+isError. Workflow-only fake asserts miss current text-only throw loss. You can mock workflow imported module to agreed result contract since sibling not integrated yet. Test no automatic extra computer_load, no native initialization for read-only/local validation where relevant, loaded roster across recoverable error, shutdown/settings/permission changes/cancellation and no unsupported hover, child policy. Do not operate real desktop. Describe API behavior/docs grounded in implemented contract, mark live acceptance unverified and do not claim original click cause fixed. Document preserved 30-second token/target rules, safe recovery without retry, launch timeout intent (sibling e.g45s inside90s), optional discovery enrichment and desktop hover limitation/side effects. Do not overwrite historical qualification logs with invented results; concise current change section if needed.

Parent will baseline-build integration checkout dependencies for workspace import availability; tests may use shared vitest binary. Follow project style and no unnecessary comments/any. Report local commits and exact verification, remaining integration needs. No independent code-review request.

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