# Task for Audit pi extensions and naming remnants

Dedicated audit of pi-imported/vendored extensions and pi naming remnants in current lunR. User specifically requests own report category. Inventory active builtin extensions, upstream origins/imports, pi paths (~/.pi), endpoints pi.dev, stale branding/docs/tool schemas, duplicates, lifecycle cleanup, intentional compatibility names @earendil-works/pi-*, ExtensionAPI pi, PI_* vs actual bugs. Inspect only tracked product not gitignored study repos. Use focused tests where valuable without overlapping bulk suites other agents run. Qualified historical PR specs in C:/Users/ash/AppData/Local/Temp/lunr-bash-08c99fbe8321da42.log; qualifiers #1-35,#37,#38,#47,#51-64,#66-70,#72,#86,#87,#97,#98,#104,#105,#112-115 and #96. Exclude Anthropic. Report inventory, severity/file/line evidence, intentional vs stale vs uncertain, tests/results and limits. No edits, builds, installs, credentials, services, GitHub writes or nested agents. Scratch outside repo allowed. Parent owns root findings doc, other agents own functional subsystems. Read repo instructions.

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