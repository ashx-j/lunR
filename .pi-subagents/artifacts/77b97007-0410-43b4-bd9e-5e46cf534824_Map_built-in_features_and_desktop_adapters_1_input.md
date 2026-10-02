# Task for Map built-in features and desktop adapters

Documentation-only feature mapping for upcoming lunR Windows desktop plan. Read AGENTS.md and relevant feature/extension docs fully. Inspect current builtins/bridges/settings enough to create exhaustive but concise built-in capability inventory with exact existing source paths and required graphical desktop adaptations. Cover providers/OAuth/model thinking/Fast, permissions/plan/goal, subagents including questions/cancellation, cron vs existing bot gateway ownership, tools web/LSP/MCP/browser with user interactions, skills/commands/memory, rollback/undo/edit, tool/thinking/spinner/todos/usage. Desktop supports ALL built-in features graphically, no third-party custom interfaces, no interactive terminal, steer only, remote-device gateway is placeholder but existing bot gateway not removed. Identify TUI dependencies and known missing structured APIs, don't assume RPC enough. No edits or code review, no reading personal credentials/config/session transcripts. Return paths, adaptations, gaps, focused tests and critical product ambiguities if any. No file ownership; read-only research.

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