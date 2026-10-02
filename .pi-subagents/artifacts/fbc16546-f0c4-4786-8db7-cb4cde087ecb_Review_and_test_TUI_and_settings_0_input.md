# Task for Review and test TUI and settings

Review and test current lunR TUI/rendering/editor/settings functionality from qualifying closed PRs. Full PR bodies/specs available C:/Users/ash/AppData/Local/Temp/lunr-bash-08c99fbe8321da42.log, read in chunks. Qualifiers #1-35,#37,#38,#47,#51-64,#66-70,#72,#86,#87,#97,#98,#104,#105,#112-115. Exclude Anthropic. Own UI only, no subagent executor/provider/gateway duplication. Heavy swarm user-approved. Inspect current code against PR requirements and standards; run focused tests including resize, scrolling, streaming, clipboard mock, model labels, settings migration. Report concrete severity/file/line/reproduction, test commands/results, baseline failures, missing coverage, every applicable PR disposition. Separate pi naming remnants. No product edits, builds into daily-driver dist, installs, live services/providers, credentials, GitHub mutations. Scratch tests only outside repo. Parent owns report, others own other subsystems. No nested agents.

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