# Subagents

Read before changing pi-subagents, intercom, `/chain` or the subagent tool schema.

## Launch contract

- Advertised children always start fresh; `fork-context.ts` stays only so upstream sync compiles, so do not advertise `context: fork`. Children are `task` + `description` + exactly one of `tier` or `model`, plus optional `permissions`. Use tiers unless the user names a model; `thinking` belongs to explicit models. Resume preserves selection from the recovery descriptor.
- Omitted `async` launches in the background; `async:false`, `clarify:true` and correlated internal bridges stay foreground. Slash and prompt workflows accept `--foreground`. Resolve launch mode in `runs/background/top-level-async.ts` after `resolveSubagentRequestParams` normalizes mixed payloads.
- Async parallel converts `tasks` into `chain.parallel`; both direct and clarify-to-background adapters must forward `model` and `thinking` with `tier`.
- Prompt-template delegation (protocol version 2) routes by tier only, so a template's `model` runs at tier `standard`; honoring it needs an optional `model` on `SubagentDelegationRequest`.
- Default parallel launch is unlimited; honor explicit `concurrency`.
- 3+ children in one `tasks`/`chain.parallel` call, or that many same-turn SINGLE `subagent` calls, share one confirmation in yolo when `/settings` Confirm large subagent launches is on (default off); auto and autonomous sessions skip it. There is no `/swarm` command.
- Subagent schema prune must keep properties named `description`. Drop control `action` when `task`/`tasks`/`chain` are present (except `schedule`/`append-step`/`resume`/`steer`); if a non-empty `task` remains, drop dummy `tasks`/`chain`.
- `description` is presentation only. Route intercom/resume/steer by private `childId`; fanout suffixes it per item and appended async steps need a fresh namespace.
- A chain step gets text through `{previous}`; notify only producers with a later step.
- `/chain` routing (`chooseChainRoute` in `pi-subagents/src/slash/prompt-workflows.ts`): a first token with `[` or a leading `(` is always a task chain; then all-workflow step names go to the workflow runner, then all-template steps (checked through `core/prompt-chain-bridge.ts`, bound per event bus by pi-prompt-template-model) go to the template chain; anything else is a task chain. The `run-prompt` tool schema still says `chain-prompts`, which keeps working, so the first-request hashes did not change.

## Permissions

- An ask parent asks before a full-access launch, and the question says the child runs without asking; the child then runs in yolo.
- Child `permissions: "full"` is not parent-equivalent: coding tools (read/search/shell/edit/write/web/LSP/MCP), no cron, memory, goals, present_plan or nested `subagent` unless fanout-authorized. The parent snapshots `PI_SUBAGENT_CHILD_PERMISSION` and, in auto, its reviewer in `PI_SUBAGENT_CHILD_AUTO_REVIEW`; full runs in auto when that is set and yolo otherwise, read-only as read-only, and every child is autonomous. A read-only parent rejects full launches. Non-child `lunr -p` stays fail-closed.
- `getArtifactsDir(sessionFile)` never points into the project; relative outputs resolve to `<artifactsDir>/outputs/<runId>`, the run directory the read-only output rule enforces, and a sync chain without `chainDir` works in `<artifactsDir>/chain-runs/<runId>`. `ensureArtifactsDir` makes the tree 0700 with `securePrivateDir` (`utils/private-dir.ts`): it refuses a symlink or another user's dir at the fixed temp name and tightens a loose one lunR made earlier. Files written there use mode 0600. The intercom broker keeps its own copy of the same check because its files are compiled and run on their own. A foreground run without a parent session gets a `pi-subagent-session-*` temp root that `removeOnExit` deletes; background runs keep theirs.
- Look up the parent's permission mode with `ctx.sessionManager.getSessionId()`. `deps.state.currentSessionId` is the session file path when one exists, which `getPermissionMode` does not know, so it silently fell back to the default mode.
- The runtime writes a child's reply to `output` itself, outside the file tools. Every place that resolves an output path calls `outputTargetError` next to `validateFileOnlyOutputMode` and refuses the launch for a protected target; `persistSingleOutput` checks again before writing.

## Display

- Compact rows are `glyph description · tier|model · tokens · time`, with `failed`/`paused`/`stopped`/`detached` appended. One line for foreground and async; no thinking, tool counts or role names. Badges use `modelSelection` captured at spawn, not `result.model`. A visible single result's header does not repeat the description. Do not print `⚠ Subagent needs attention` cards.
- Child event frames apply only to print JSON in a child; the parent decodes them before persisting. Keep the per-line guard and total-event cap. `cacheRead` is separate from the compact row count.

## Async runs, questions and delivery

- Async recovery descriptors store resolved acceptance. Read them with the persisted validator, not launch-input `validateAcceptanceInput`, and do not re-infer from the revival wrapper. Pass the current follow-up separately as `completionTask`.
- Supervisor ownership uses `PI_SUBAGENT_SUPERVISOR_SESSION_ID`; routing keeps `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`. Compare each exactly. `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` skips broker `contact_supervisor` and broker spawn; the broker must not replace the native schema.
- Only answered supervisor questions wake the parent. Blocking `need_decision`/`interview_request` is `needs_attention` for `subagent_wait`. The owner notifier delivers terminal results once; relays keep ACK/retry but skip local delivery when `ownerNotificationSessionId` matches. Parent cards show the `handoff` kind as `progress`.
- Async Escape: a second press within 500ms stops session-owned runs through a lazy session-keyed bridge. Stop requests differ from confirmed termination; stopped completions do not wake the parent. Delivery retries reuse the request id and keep the file after three failures.
- Interactive `subagent_wait` interruption is run-scoped: capture the owning signal at wait start, release only those waits, and wait for `agent_settled` before the fresh prompt. Do not infer execution from TUI cards or abort siblings.
- Subagent communication is a global setting snapshotted per run; turning it off blocks new parent questions and steering at once while pending replies finish.
- Intercom broker spawn prefers sibling `broker.js` with node. On Windows `cmd.exe` cannot redirect into `broker.stderr.log` while the parent holds it; the launcher waits for an exit code only during startup. Fixtures must stop their broker before removing its profile.
- The broker socket stays at `<agentDir>/intercom/broker.sock` while that path fits in sun_path (107 bytes Linux, 103 macOS). A longer profile uses `/tmp/lunr-intercom-<uid>/<sha256(agentDir)[:16]>.sock`. The base is fixed so a cron, systemd or ssh session with another `XDG_RUNTIME_DIR` or `TMPDIR` finds the same broker. Both sides refuse that dir when it is a symlink, another user's or has any group or other bit, and the error names it and says to remove it. Another local user can create the fixed name first; there is no fallback.
- The broker exits 5 s after its last connection closes, counted from when it starts listening, so a broker whose client died before registering exits too. The spawner SIGKILLs the broker's process group when it never listens within 5 s. Under a full pids cgroup (`agent-work.slice` has `pids.max` 512) Node can hang in its own startup with 2 to 5 threads, 0 CPU time and no socket, before any broker code runs.
- Default-off watchdog startup must never fingerprint the repo; establish the repo-edit baseline only at `before_agent_start`.
