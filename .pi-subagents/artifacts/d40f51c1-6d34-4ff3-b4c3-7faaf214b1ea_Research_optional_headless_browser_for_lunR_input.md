# Task for Research optional headless browser for lunR

Research the best way to add an optional headless browser capability to lunR so agents can interact with websites, beyond the existing web_search and fetch_content tools. This is research only: do not modify files, install anything, or change settings. User explicitly wants browser automation as an additional option, not a replacement for search/fetch. Inspect relevant lunR architecture and existing web/MCP capabilities, read relevant docs completely, and use current web research with citations to official sources. Compare practical options such as Playwright directly, a browser MCP integration, and other credible agent-oriented approaches, focusing on a simple maintainable TypeScript integration, Windows support, lazy loading/startup impact, browser installation/lifecycle, accessibility/DOM snapshots versus screenshots, session state, security and permissions, and token/runtime costs. Recommend a concrete MVP tool design and routing guidance that keeps search for discovery and fetch for ordinary readable pages, reserving browser actions for interaction/JS-dependent tasks. Distinguish what exists today from proposed work, explain tradeoffs and rough implementation scope, and identify any decisions Ash needs to make. Do not perform a general code review. Return a concise plain-English recommendation with enough technical detail to guide a later implementation and source links. All file ownership is read-only; no implementation is authorized.

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