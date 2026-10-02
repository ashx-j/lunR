# Task for Inspect upstream code for a reuse-first lunR port

Inspect upstream repository C:/tmp/pi-github-repos/miuuyy/codex-chatgpt-web, already fetched at eaf4f09ae92d4dc4429fa597b0861663138f08f8, to support REWRITING root CHATGPT_WEB_NATIVE_PLAN.md as a code-first port, not a fresh implementation. Read current plan. User requires reuse already-working upstream code, native lunR setup/provider/tools/subagents, dedicated login browser acceptable, all Windows/macOS/Linux, automatic mode. Read-only research only; parent owns and edits plan exclusively. Determine concrete source directories/files to carry over mostly intact, minimal Codex-specific adaptation points, Electron browser host and launcher runtime ownership dependencies, Bun-specific runtime needs, packaging/license assets to retain. Recommend lowest-rewrite viable approach even if retaining an internal Electron helper/Bun runtime is necessary. Inspect actual code, not just README. Explicitly distinguish directly reusable from genuinely needs edits and unresolved proof gates. Report migration sequence and contracts particularly original Responses adapter vs native lunR stream bridge, preserving browser-helper/progress/turn broker/compaction machinery. No code review, no file edits, no subagents.

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