# Task for Validate PR77 builds tests and stable packaging

User wants PR77 in mergeable state, then report and await next steps. You are second of exactly two sequential GPT-6 Astra high reasoning workers. First worker handoff: Ready for the second writer. No push or merge.

Commits:
- Integration: `990742a571978749f49979eb20cb32c67ca3fa52`
- Repairs/HEAD: `6263c85d94069c58df9955157a40d63ec5a7c14f`

Handoff saved to `C:/Users/ash/Desktop/PROJECTS/lunR/implementation-handoff.md`.
Read C:\Users\ash\Desktop\PROJECTS\lunR/implementation-handoff.md if present. You are now sole writer of C:/Users/ash/Desktop/PROJECTS/lunR-image-only. Your job is validation and fixing necessary remaining integration/build/test/packaging failures, NOT an independent code review or broad cleanup. No nested subagents. No PR merge, push, publication, global/daily-driver installation, user settings or credential changes, live desktop control, actual CuaDriver launch, or upload of private files. Root C:/Users/ash/Desktop/PROJECTS/lunR is unrelated dirty checkout, never edit or rebuild there. Local isolated test package installations with fake payloads/appropriate sandbox allowed, no real native runtime invocation.

Read worktree AGENTS.md fully, packages/coding-agent/docs/computer-use.md fully, related interactive-startup docs fully, and C:/Users/ash/.agents/skills/writing-for-agents/SKILL.md before AGENTS edits. Verify handoff commit and working tree; if first agent left unresolved merge/failed integration, complete it safely preserving PR ancestry. Confirm latest fetched master is ancestor; normal merges only, no force/rebase. Original PR remote feat/native-computer-use head a87b3782015cd2c99a21c0065defacd26d75d257, current known master b57c14889a045e95a15a6a52c6cd39345f4c0f64. Preserve feature permissions and latest master behavior.

Run meaningful focused computer workflow, adapter, extension, image/Photon, runtime, lease, platform fake-driver, cron, permissions and packaging tests as appropriate. Run five offline package tsgo builds in order tui->ai->agent->coding-agent->orchestrator, then coding-agent Node bundle. NEVER npm run build in packages/ai. Confirm worktree dependency and npm-bin isolation; do not let build/test commands run original checkout. Run first-paint/first-request tool coverage with clean inherited PI_* runtime env, update supported/unsupported host fixture only for intentional tool changes. Regenerate affected local prompt/tool inventory without committing private snapshot. Validate stable public package staging/dry-run and relocated isolated install with host optional payload selection, omitted optional payload recovery, exact lockfiles and rewritten JS/d.ts names using existing safe scripts. Production CuaDriver approval must stay false/development-only: user request does not authorize production pin approval or release. Do not disable approval gate merely to make packaging test green. Prefer existing fake archive tests and offline cached artifacts; if full stable staged packaging requires unavailable archives or production approval, precisely report blocker instead of manufacturing evidence.

PR's last GitHub CI a87b378 run35516076841 job106092132879 passed offline build, first-request, check but failed Test. API annotations include preexisting-looking install-features gateway token inference, extensions-discovery entrypoint, sigterm fixture stopSmoothStreaming missing, OpenCode/catalog and Anthropic metadata fixtures. Determine baseline vs introduced failures using an isolated base comparison where needed, not assumptions. Fix introduced failures and feature-related stale expectations. Don't silently relabel failing CI merge-ready. If unrelated baseline failures prevent clean CI, identify exact evidence and smallest necessary next decision rather than broad unrelated rewrite. No fresh live provider requests needed.

Run changed-file checks and git diff --check. Update public-safe computer-use docs/AGENTS with exactly verified results and remaining native hardware acceptance limitations. Existing dev claim265 tests is historical, not fresh evidence. Cursor animation and screenshot history remain explicitly deferred. No live desktop test allowed; fake foreground recovery verification only. Keep original runtime pin and stable publication approval gate intact. Commit intended validation repairs/docs only, no git add -A, no secrets/private artifacts/unrelated catalogs/binaries. Finish with exact HEAD/commit list, current master ancestry, tests counts/results, packaging evidence, any failures/blockers, public-safe suggested PR update, and whether safe to push the PR branch without merge/release. Save final handoff at C:\Users\ash\Desktop\PROJECTS\lunR/validation-handoff.md. Parent will inspect your report and update PR only if justified; do not push.

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