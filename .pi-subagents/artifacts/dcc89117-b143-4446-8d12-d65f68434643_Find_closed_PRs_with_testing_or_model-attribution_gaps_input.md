# Task for Find closed PRs with testing or model-attribution gaps

Read-only research of this lunR repository's CLOSED GitHub PRs, including merged PRs. User wants a scoped future review to avoid spending tokens re-testing well-tested work. Identify PRs likely lacking sufficient test execution evidence. Also automatically include any PR filed by a Grok model or with no model slug attached in PR comments (user wrote 'commet'; inspect PR body/comments and commit attribution where useful, explain interpretation). Use local git remote and GitHub CLI read operations to discover repository and closed PRs, inspect test evidence, CI conclusions, descriptions/comments, model attribution. Do not edit files, post comments, run tests/builds, or change GitHub state. Never upload private local data. Be economical: list all closed PR metadata first, then inspect details needed to classify; exclude clearly superseded/duplicate unmerged work from active code risk but report separately if it qualifies. Distinguish missing evidence from tests actually not run. Record scope/count/date bounds and limitations. Return a prioritized shortlist with PR numbers, titles, links, merged vs unmerged, concrete reason, model slug/evidence or missing, test evidence, and recommended narrow review/test focus. Include a brief well-tested exclusion summary and account for later PRs testing the same code so user avoids duplicated testing. You own research only, no files. Read repository instructions as needed. This is a historical PR test-evidence audit, not a full code review and not permission to run tests.

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