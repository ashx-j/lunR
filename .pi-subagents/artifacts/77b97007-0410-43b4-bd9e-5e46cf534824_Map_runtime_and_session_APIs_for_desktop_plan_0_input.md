# Task for Map runtime and session APIs for desktop plan

Documentation-only architecture research for a Windows Electron + React + TypeScript desktop around lunR. Read AGENTS.md and relevant sdk/rpc/session docs fully. Inspect existing SDK, AgentSession, SessionManager, resource loader, permissions and settings enough to identify exact reusable APIs and missing desktop adapters. No code review or edits. Need concise report with file paths/symbols and critical constraints: multi-thread runtime ownership separate from view, steering only, full builtin graphical UI no third-party custom terminal UI, shared credentials/settings and TUI history, preventing simultaneous TUI/desktop control, JSONL source of truth plus UI metadata, replay/reconnect snapshot and typed local protocol future remote. Existing remote work paused. Desktop uses app-managed matching CLI dependency; never modifies existing global CLI. Research public/source code only, not user secrets/settings/session transcripts. Return architecture recommendation, missing contracts, focused acceptance tests. You own no files; read-only.

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