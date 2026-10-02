# Task for Review PR77 repository standards

READ ONLY review of PR77 standards axis. No edits/builds/installations/native driver or desktop interaction. You own standards; other heavy reviewer owns correctness/spec. HEAD a87b3782015cd2c99a21c0065defacd26d75d257 matches live PR. Confirm fixed base 92caf64f28bf9514545f85869984375de063cc0b. Exact diff: git diff 92caf64f28bf9514545f85869984375de063cc0b...a87b3782015cd2c99a21c0065defacd26d75d257. Commits: a87b378 carry dev-verified image-only repairs; c5a9327 bounded discovery/recovery; 3bb9839 ancestry merge; d3182e4 image-only observations; afea9dc atomic ownership; 290658d/6f5d8cd native CuaDriver implementation. Standards sources: read worktree AGENTS.md completely, discover any further applicable tracked standards; packages/coding-agent/docs/computer-use.md full for contract context. User standards: scope narrowly, simple typesafe TS, avoid any and casting-wrapper helpers, reuse existing deps. Focus on all 50 diff files including packaging, tests, descriptions/coverage, architecture. Report every substantive documented-standard violation with standard file+rule and code file/line, plus judgement-call smells. Skip tooling-enforced formatting/lint issues. Smell baseline: Mysterious Name = name hides purpose, rename or clarify design. Duplicated Code = repeated logic shape across changes, share implementation. Feature Envy = reaches into another object's data more than own, move behavior. Data Clumps = same fields travel together, bundle as type. Primitive Obsession = primitive/string deserves domain type, introduce one. Repeated Switches = repeated same-type cascades, use shared map/polymorphism. Shotgun Surgery = one change scattered across files, centralize responsibility. Divergent Change = one module edited for unrelated reasons, split. Speculative Generality = abstractions/hooks unneeded by spec, remove. Message Chains = long navigation caller shouldn't know, encapsulate. Middle Man = mostly delegating class/function, inline delegation. Refused Bequest = ignores inherited behavior, prefer composition. Each baseline smell is ONLY a judgement call; documented repo rules override baseline; do not add abstractions just to satisfy smells. Distinguish hard violation vs possible smell; concrete evidence and impact, not generic style complaints. Under 400 words final. State inspection/test limits. No artifact upload.

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