# Task for Implement optional browser and file PR from master

Implement the approved optional Playwright headless browser feature in lunR, and file a PR. You are the sole full-access writer for this task. User explicitly authorizes implementation on a NEW branch from master and filing a PR. Do not merge, publish, change installed global CLI, touch daily-driver builds, or overwrite unrelated local changes. First inspect git state; use a separate git worktree from master for isolation if working tree/build safety warrants it. Never use archive/extension-absorption-DO-NOT-MERGE. Read project instructions and relevant lunR docs fully. Read file-pr skill at C:/Users/ash/.agents/skills/file-pr/SKILL.md before filing PR, and writing-for-agents skill before AGENTS.md edits. No nested subagents or unsolicited reviews.
Approved implementation plan: optional first-party Playwright-backed single browser tool, preserving web_search for discovery and fetch_content for reading. Explicit setup via existing optional-feature machinery, disabled until configured; pinned dependency, matching Chromium installed only by explicit user setup, never on regular npm install/startup/tool execution. Lightweight deferred extension/schema, Playwright dynamic import on first use. Session-owned isolated ephemeral context with serialized operations, bounded tabs/output/timeouts, cleanup on replacement/shutdown/cancellation/idle. Separate child sessions. Actions navigate, inspect, act (click/fill/select/check/press), tabs (list/create/select/close), screenshot, close. Prefer accessible roles/names/labels, fail ambiguity, bounded snapshots and explicit screenshot only. No arbitrary evaluate tool, uploads/downloads, clipboard/device grants, existing browser attachment, imported cookies, persistent profiles. Integrate existing permissions: plan/read-only can navigate/inspect but not act; manual approves interactions; auto/yolo preserve their existing contracts, don't invent irreversible-action classifier. HTTP(S) public sites default, explicit user configuration for local/private network; validate redirects and subrequests as well as navigation, consider DNS/IP/private targets carefully and document limitations honestly. Page content is untrusted, /undo cannot reverse external effects. Tool routing guidance in descriptions of browser/search/fetch, no automatic browser fallback and no forced fetch before explicit interaction tasks. Compact tool rendering and meaningful conditional errors/recovery. Tool registration/child allowlists/permissions/schema coverage must be accurate. Keep implementation simple and typesafe, avoid unnecessary comments and unrelated changes.
Validate with focused local fixture website tests for JS rendering, multi-step interaction, ambiguous targeting, truncation, permissions/network policy, missing browser, isolation/cancellation/cleanup. Offline package builds in isolated worktree with coding-agent Node bundle, Windows actual browser launch and first-paint/first-request verification, scripted local-provider real CLI tool flow as feasible; never modify original daily-driver dist. Update relevant tool coverage/schema fingerprints/system prompt inventory if affected, shipped documentation, repo AGENTS current state/build evidence/decision. Network/install steps necessary in isolated worktree are authorized as part of implementation, but do not send private data to public services. Inspect staged changes for accidental private/local artifacts before push. Commit focused changes, push feature branch and open concise PR against master using skill. Report PR URL, commit, implementation summary, exact tests/results and residual risks. If genuine blocker occurs, report it rather than claiming success. Prior research recommends direct Playwright, no current browser dependency, deferred builtins in packages/coding-agent/src/builtin-extensions/index.ts, permission gate in core/permissions.ts; existing MCP permission concerns are out of scope to fix.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

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
    },
    {
      "id": "criterion-2",
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