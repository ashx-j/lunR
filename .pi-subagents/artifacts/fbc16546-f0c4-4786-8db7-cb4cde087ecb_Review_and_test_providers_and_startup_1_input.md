# Task for Review and test providers and startup

Review/test current lunR provider/catalog/auth/usage/startup behavior from qualified closed PRs #1-35,#37,#38,#47,#51-64,#66-70,#72,#86,#87,#97,#98,#104,#105,#112-115. PR body specs in C:/Users/ash/AppData/Local/Temp/lunr-bash-08c99fbe8321da42.log read chunks. EXCLUDE Anthropic subscription work entirely. Own providers, Codex Fast, multi-plan usage, catalogs and cold-start only. Inspect requirements vs implementation and repo standards; run focused fixture tests, no real credentials or live providers. Report severity/file/line/evidence, commands/results, baseline vs new failures, coverage/disposition for applicable PRs. Separate pi remnants. No product edits, daily-driver dist builds, installs, network auth, services, publication or GitHub writes. Scratch repro outside repo permitted. Parent writes report; UI/subagent/gateway/pi agents separate. No nested agents.

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