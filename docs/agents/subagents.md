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

- Child `permissions: "full"` is not parent-equivalent: coding tools (read/search/shell/edit/write/web/LSP/MCP), no cron, memory, goals, present_plan or nested `subagent` unless fanout-authorized. The parent snapshots `PI_SUBAGENT_CHILD_PERMISSION` and, in auto, its reviewer in `PI_SUBAGENT_CHILD_AUTO_REVIEW`; full runs in auto when that is set and yolo otherwise, read-only as read-only, and every child is autonomous. A read-only parent rejects full launches. Non-child `lunr -p` stays fail-closed.

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
- Default-off watchdog startup must never fingerprint the repo; establish the repo-edit baseline only at `before_agent_start`.
