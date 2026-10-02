# Task for Inspect TUI reuse and local-to-remote session handoff

Read-only architecture investigation for implementation PLAN. Cwd C:/Users/ash/Desktop/PROJECTS/lunR. Own TUI/client boundary, rendering, extension UI, commands, terminal compatibility, future app reuse. User requires ONE normal lunR installation Windows/macOS/Linux that can host and connect, automatic login background host, exact running sessions move between local PC TUI and laptop TUI without cancelling. Preserve current TUI first. Future app wraps/manages CLI and supports terminal plus graphical view. Inspect relevant source/docs fully, identify concrete coupling to local AgentSession/files/settings/auth/terminal and propose minimum well-designed reusable local/remote client contract. Does transparent handoff require host-owned local sessions from birth? Account for custom extensions, permission/plan dialogs, subagent widgets, clipboard/image/file paths, local vs host settings, shortcuts, smooth streaming, multiple attached clients, app terminal embedding vs structured API. Give concrete paths, sequence of changes, meaningful acceptance tests, complexity risks. Not a code review, no edits/builds/services/secrets. Other agents own runtime/protocol and setup/networking.

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