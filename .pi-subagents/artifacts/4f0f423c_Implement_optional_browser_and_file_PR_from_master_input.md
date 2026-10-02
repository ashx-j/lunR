# Task for Implement optional browser and file PR from master

You are reviving a previous subagent conversation.

Original run: 8d1a4cf3-acd1-40df-9fff-ad47d95b0e09
Original agent: Implement optional browser and file PR from master
Original session file: C:\Users\ash\.lunr\agent\sessions\--C--Users-ash-Desktop-PROJECTS-lunR--\2026-09-20T14-03-29-075Z_01a0bf21-0bb3-7803-b70e-560e3fac1aaa\9a046632\run-0\session.jsonl

Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.

Follow-up:
User requests changing PR #93: 'i dont like the way it is optional in the pr. I want to change it so it is automatically installed but can be disabled in settings.' Implement this changed requirement in your existing isolated worktree/branch and update same PR. You remain sole writer. Browser should be enabled by default and matching Chromium installed automatically as part of normal supported installation/update flows, with a Browser toggle in /settings to disable it. Replace opt-in setup requirement; preserve lazy runtime loading/no browser process at startup and preserve search/fetch preference. Respect --ignore-scripts/offline installs: diagnose missing binaries clearly, do not silently install on model tool calls; document such exceptional recovery. Inspect packaging/public-name rewriting, npm lifecycle/shrinkwrap/standalone setup and pick simple reliable automatic install integration compatible with workspace vs published packages, Windows, existing browser caches. Avoid downloading browsers during every startup or ordinary build. Disabling should hide tool and close active browser safely; no deletion of cached binaries required. Ensure existing users' settings migrate/default appropriately, explain how legacy explicit disabled optional-feature setting is handled rather than accidentally overriding user intent. Update tests/schema fingerprints/docs/AGENTS and PR title/body to reflect built-in default-on capability. No unrelated changes, no merge/publish/global install/original-dist modifications. Validate targeted install behavior in isolated profiles/package staging, setting toggle/cleanup/default inventories, focused browser flows/build/startup. Commit/push updates to same PR and report evidence and limitations. Read applicable skills as before. No independent review requested.

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