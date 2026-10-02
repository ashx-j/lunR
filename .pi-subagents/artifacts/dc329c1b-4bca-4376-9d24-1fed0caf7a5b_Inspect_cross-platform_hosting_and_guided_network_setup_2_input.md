# Task for Inspect cross-platform hosting and guided network setup

Read-only research for deep implementation PLAN. Cwd C:/Users/ash/Desktop/PROJECTS/lunR. Own existing gateway/installer/CLI setup and OS service/network integration. User wants same default lunR package on Windows/macOS/Linux to host and connect, no separate edition; opt-in hosting auto starts at sign-in and survives closed terminals; preserve TUI and exact live sessions across devices. Support both Tailscale and self-hosted WireGuard, guide setup and automate installation as far as safe with explicit permission. No paid infrastructure required. Inspect existing CLI gateway setup/service code and packaging dependencies/docs fully; cite concrete files to reuse/extend without conflating Telegram gateway with remote interactive sessions. Research official current docs via web for platform auto-start services, Tailscale setup/network restrictions, WireGuard automation/public endpoint/CGNAT realities, credentials/device trust/TLS security. Recommend architecture, easy setup flow, safe privilege boundaries, uninstall/update handling, sleep/offline behavior, host capability differences, testing strategy, phases. Distinguish support all 3 OS from development/testing evidence. No edits, install, services, credential reads, or external mutations. Other agents own runtime/protocol and TUI.

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