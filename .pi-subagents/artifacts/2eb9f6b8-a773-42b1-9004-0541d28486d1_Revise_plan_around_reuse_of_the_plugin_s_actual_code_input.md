# Task for Revise plan around reuse of the plugin's actual code

Revise root ANTHROPIC_OAUTH_CLAUDE_CODE_PLAN.md to explicitly reuse the existing Hermes plugin implementation rather than rebuild from behavior descriptions. User explicitly asks use standard tier and permits downloading/inspecting plugin. You are sole writer for ANTHROPIC_OAUTH_CLAUDE_CODE_PLAN.md and minimal required AGENTS.md planning-state updates only; do not modify runtime code or unrelated files. Read existing plan and repo instructions. User decisions: built-in existing anthropic provider; official Claude Code dependency installed only upon explicit user choice of Anthropic OAuth, never lunR installation/startup; fully replace direct Anthropic OAuth, API keys unchanged. Source https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk and pinned repo https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/f1c1220778c7864fe4c1494baf9b1566e7c95bd2 . Download public source into temp directory outside project, inspect actual implementation and tests completely as relevant. No executing upstream code/installers, no credentials/live inference. User wants code reuse; make grounded decision for highest practical reuse, explicitly distinguish unchanged vendoring plus thin bridge vs TypeScript translation. Do not silently call a fresh TypeScript implementation code reuse. If Python runtime needed for direct reuse, explain proposed on-demand dependency setup and tradeoff in plan, mark proposed not already user-approved. Prefer retaining proven upstream transport as much as practical, with thin lunR adapter, rather than recreating protocol. Identify exact upstream files/functions/tests reusable unchanged, minimal patches needed, Hermes dependencies to replace, Node/Python bridge protocol, lifecycle cancellation cross-platform, packaging/license/pinned-update strategy. Verify source licensing. Revise existing plan, removing contradictory from-scratch/mandatory TS-port assumptions. Keep scope reasonable and distinguish verified source observations vs proposed work. Read writing-for-agents skill if modifying AGENTS. This is planning only, no implementation/review agents. Validate doc consistency and git diff --check; do not run runtime builds for docs. Report files changed, pinned source location, substantive findings, and any user decision still needed. Do not commit, push, install anything, or touch user's global configs. Other preexisting changes/untracked files must remain untouched.

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