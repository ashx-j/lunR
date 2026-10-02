# Task for Review lunR remote sessions and work controls

Read-only architecture/correctness review of lunR gateway for user wanting full remote coding from phone. Cwd C:/Users/ash/Desktop/PROJECTS/lunR. Own inspection only of packages/coding-agent/src/gateway/{agent-bridge,router,approval,store,commands,cron}.ts and relevant core integration/tests. Parent inspects CLI/service/settings/platform adapters, another child inspects Hermes. Do not edit files or start gateway/live services/access credentials. Read applicable AGENTS and relevant docs completely. Trace remote parity and reliability: loaded tools/extensions, permission/plan approval, subagent lifecycle and questions/notifications, goal/cron, persistent sessions/resume/project switching, concurrent phone/local session, busy stop/new handling, cold first turn. Identify confirmed gaps or bugs with file:line evidence, distinguish unverified concerns. Recommend smallest coherent changes for genuine away-from-home work. Run only focused safe tests if useful; avoid broad suite. Report <=1100 words, code references and residual uncertainty.

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