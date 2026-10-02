# Task for Design safe TUI and phone session handoff

Planning only, read-only. Design safe TUI↔gateway session handoff for lunR in C:/Users/ash/Desktop/PROJECTS/lunR. This is 1 of max 2 heavy children authorized for whole project. Do not edit files, install dependencies, start services, access credentials, or run further agents. User approved gateway improvements: project folder button browser, actual service lifecycle/autostart, native Telegram/Discord commands, full remote runtime notifications/permissions, file exchange. New exact requirements: interactive `lunr gateway setup` simple platform instructions; mobile `/sessions` can open and continue ANY session started in TUI across projects; gateway `/continue` prefers TUI `/handoff` manually marked sessions, if none manually added uses latest active TUI session; manual handoff entries expire after 8 hours. Need implementation PLAN, not implementation. Own only session handoff/lifecycle/command architectural investigation. Parent plans setup/services/adapters. Read applicable AGENTS and relevant lunR docs completely. Review existing core AgentSessionRuntime, SessionManager, interactive commands, permission contexts, intercom as applicable, gateway bridge/store/commands. Find smallest coherent architecture for per-session cross-process ownership preventing independent stale TUI+gateway writes, busy transfer consent, reclaim, stale owner recovery, preserving original cwd/history. Define semantics multiple manual candidates, expiry only discovery not deletion, latest active definition, durable activity without per-token file writes, owner-only access across projects. Consider existing session writers beyond TUI/gateway. Avoid overbroad refactor/overpromise; distinguish essential phase vs deferred. Return concrete file/function touchpoints, data contracts, implementation order and focused tests. <=1400 words. No need full standards review.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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