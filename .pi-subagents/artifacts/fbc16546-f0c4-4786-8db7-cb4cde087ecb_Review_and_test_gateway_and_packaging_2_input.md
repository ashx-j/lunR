# Task for Review and test gateway and packaging

Review/test current lunR gateway/session handoff, packaging/releases/dependency and shipped docs changes from qualified PRs #1-35,#37,#38,#47,#51-64,#66-70,#72,#86,#87,#97,#98,#104,#105,#112-115 plus #96 outstanding gateway scenarios. Full PR specs in C:/Users/ash/AppData/Local/Temp/lunr-bash-08c99fbe8321da42.log read chunks. Exclude Anthropic subscriptions completely including release-contained changes. Own gateway/packaging only. Run focused fixture tests for ownership, handoff, approval, cron authorization, service lifecycle logic and package contracts. No actual bot messages, service installs/start/stop/reboots, credentials, real providers, publication or GitHub writes. No product edits or daily-driver builds. Scratch outside repo permitted. Report concrete severity/file/line/reproduction, test commands/results, baseline failures, untestable live gaps, qualified PR disposition. Include separate pi remnants. Parent writes final report; other agents handle UI/executor/providers/pi. No nested agents.

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