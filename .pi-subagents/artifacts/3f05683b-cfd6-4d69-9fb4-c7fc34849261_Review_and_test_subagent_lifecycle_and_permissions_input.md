# Task for Review and test subagent lifecycle and permissions

Audit and test current lunR subagent execution, permissions, lifecycle, intercom and approvals corresponding to qualified closed PRs #1-35,#37,#38,#47,#51-64,#66-70,#72,#86,#87,#97,#98,#104,#105,#112-115. Exclude all Anthropic subscription work. User approved heavy swarm review/testing. Own this subsystem only. Read repo instructions and code-review/diagnosing skills as applicable. Run focused source tests, inspect actual assertions and implementation, report concrete severity/file/line/reproduction evidence; distinguish baseline failures. Include pi naming/import/path remnants in a separate section. Do not edit product files, build daily-driver dist, access credentials, install, publish, use live providers/services or modify GitHub. Temporary isolated test artifacts permitted outside repo. No nested agents. Return tests/commands results, gaps, qualified PR coverage and superseded dispositions. Other agents own UI, providers/startup, gateway/packaging, and pi inventory. Parent writes root report.

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