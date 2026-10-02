# Task for Review interruptible subagent wait design

Read-only design review. The user reports that while the interactive parent is blocked in the `subagent_wait` tool, pressing Enter puts their message in the visible Steering queue until the wait finishes. They want Enter to send immediately and not use steering semantics. Inspect `origin/master` only, especially agent-loop/tool termination, AgentSession queue APIs/events, InteractiveMode submission/tool tracking, and pi-subagents wait tool. Propose the smallest robust design that makes a user submission end only the active `subagent_wait`, end that agent run cleanly, and then submit the text as a normal new prompt while background children continue. Consider simultaneous tool calls, images, extension commands, session replacement/abort, ordering, UI, and tests. Do not edit files. Return concrete files/functions, invariants, risks, and focused validation commands.

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