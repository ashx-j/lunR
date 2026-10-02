# Task for Integrate PR77 and repair computer-use behavior

User authorizes making PR https://github.com/ashx-j/lunR/pull/77 mergeable using exactly two GPT-6 Astra high reasoning agents, then report and await next steps. You are first of two sequential full-access writers in C:/Users/ash/Desktop/PROJECTS/lunR-image-only. You own current-master integration and computer-use behavior repairs, focused tests, docs, and local commits. Second agent will take over only after you finish, owning verification and any necessary remaining build/package/test repairs. No nested agents. Do not review unrelated code or redesign. DO NOT MERGE PR, PUSH, PUBLISH, install/update daily-driver CLI, change user settings/credentials, operate desktop, launch real CuaDriver, or transmit private artifacts to public services. Local safe fake-driver tests and isolated builds permitted; not original C:/Users/ash/Desktop/PROJECTS/lunR builds. Keep untracked .pi-subagents and all private plans out of commits.

Initial HEAD a87b3782015cd2c99a21c0065defacd26d75d257 on feat/image-only-computer-use equals PR head feat/native-computer-use. Original merge base 92caf64f28bf9514545f85869984375de063cc0b. Latest observed origin/master b57c14889a045e95a15a6a52c6cd39345f4c0f64, 0.2.24, PR reports conflicts. Verify working tree, fetch origin master and PR branch narrowly. Preserve PR ancestry with a normal merge of current master into this branch, no rebase/force push. If PR remote moved unexpectedly, stop and report rather than overwrite others. Resolve integration conflicts preserving current master's unrelated features plus native computer use. Root checkout has unrelated dirty work: never edit it.

Read worktree AGENTS.md completely and packages/coding-agent/docs/computer-use.md fully, plus C:/Users/ash/Desktop/PROJECTS/lunR/COMPUTER_USE_RECOVERY_PLAN.md fully as PRIVATE spec. Read writing-for-agents skill at C:/Users/ash/.agents/skills/writing-for-agents/SKILL.md before updating worktree AGENTS.md. Read related startup docs completely before startup/build adjustments. Tool changes must update structured descriptions, conditional recovery guidance, coverage and applicable fingerprint/inventory; private effective prompt snapshots stay local.

Required confirmed fix: src/core/computer-use/workflow.ts execute catch currently always warns 'Input may have taken effect' at old line 319 even if bad/expired/wrong-target token or argument validation failed before driver dispatch. Implement accurate structured pre-dispatch failure (input:'not_dispatched', no input sent by THIS call) versus post-dispatch uncertainty, preserve cleanup/lease and conservative uncertain/partial outcomes. Do not imply earlier calls had no effect. Distinguish token causes only as state supports. Preserve exact target binding, 30sec lifetime, single-use token, invalidation on failed action/new observation; no fuzzy tokens, retries, escalation or persistent token registry. Conditional guidance: copy token exactly; failed call consumes token; fresh capture before next action including focus; background_unavailable recovery = fresh capture then foreground candidate, not another background shortcut; token rejection does not prove foreground typing failed. Native foreground tests require separate approval, so use fake driver sequence only.

Two review findings require focused reproduction before scoped repair: (1) workflow outcome() old lines65-70 copies unparseable driver text up to240 chars, potentially letting raw JSON/accessibility fragments into model output despite allowlisted contract. Show with safe fake reply then eliminate raw fallback leakage while preserving useful bounded structured refusal codes/recovery. (2) workflow old156/290 hashes base64 PNG encoding rather than decoded pixel values; identical pixels with differing PNG encoding can evade identical-captured-pixels repeat rule. Establish a real PNG fixture test without driver; if confirmed use existing image processing dependencies for stable pixel identity without unnecessary abstraction or costly duplicate decoding. Preserve crop/resize coordinate mapping and bounds. Do not broaden into cursor animation/history pruning/token format redesign. Standards review found only optional type-erasure and repeated-registration smells: fix only if naturally necessary, no cleanup campaign.

Write focused tests first where practical covering malformed/expired/wrong-target/consumed token zero native dispatch, post-dispatch and post-image uncertainty, background refusal fresh-capture foreground recovery, and confirmed conditional findings. Follow repo offline tsgo rules, never npm run build in packages/ai. Check dependency/worktree isolation before running tools because npm shims may point to original checkout. Commit only intended tracked source/test/docs/integration changes; never git add -A. Do not stage private artifacts, runtime binaries, credentials, generated catalogs, or unrelated files. Update AGENTS current state/build evidence/one-line decision, keeping claims honest and public-safe. Finish with exact commits/HEAD, changed files, commands/results, remaining risks and precise handoff to second agent. Save succinct handoff to C:\Users\ash\Desktop\PROJECTS\lunR/implementation-handoff.md using permitted file tools. No push; parent handles PR update after second agent.

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