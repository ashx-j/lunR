# Task for Inspect persistent sessions and remote protocol architecture

Read-only architecture investigation for a deep implementation plan, not implementation or general code review. Repo cwd C:/Users/ash/Desktop/PROJECTS/lunR. Scope ownership: session/runtime lifecycle, RPC, persistence, subagent/cron ownership, remote protocol and reconnect design. User wants built-in remote operation in the SAME lunR package on Windows/macOS/Linux, no separate host product. Any installation can host or connect. Background hosting starts at login and survives terminal/client disconnects. A session begun locally on PC must be attachable as the exact running session on laptop. Preserve existing TUI, later app supports terminal and graphical views as wrapper around CLI/engine. Both Tailscale and self-hosted WireGuard supported, guided installation. Inspect actual repo and relevant docs fully. Identify concrete files/APIs to reuse/change, critical lifecycle constraints, daemon ownership options and recommend simplest robust architecture. Distinguish existing capability from needed changes, discuss session continuity vs process restart, worker isolation, approvals while offline, replay/snapshot/deduplication, subagents/cron interaction. Report phased changes, focused acceptance tests, risks and unresolved decisions. Do not edit files or run builds affecting dist; no secrets or live services. Other agents own TUI and installer/networking; stay scoped.

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