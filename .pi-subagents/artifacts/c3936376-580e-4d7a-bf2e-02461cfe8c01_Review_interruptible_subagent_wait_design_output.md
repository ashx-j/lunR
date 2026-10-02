Reviewed only `origin/master` at `e083fc4a3fae11719d51f711625655655ea36fe0fe` would be incorrect; the inspected revision was `e083fc4a3fae11719d51f7116256555ea36fe0fe`. No files changed.

## Findings

1. **Medium, confirmed cause.** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3309–3319` sends every ordinary Enter submission during streaming through `prompt(..., { streamingBehavior: "steer" })`. `AgentSession.prompt()` then calls `_queueSteer()` at `packages/coding-agent/src/core/agent-session.ts:1332`. The visible Steering queue accurately reflects current behavior.

2. **High, implementation trap.** Returning `terminate: true` from the wait is insufficient. In `packages/agent/src/agent-loop.ts`, `shouldTerminateToolBatch()` requires **every** tool result to terminate. Even then, `runLoop()` still polls steering and follow-up queues. A parallel sibling tool or queued notification can keep the old run alive.

3. **High, implementation trap.** `AgentSession.abort()` at `agent-session.ts:1719` aborts the shared agent signal. Tool executions receive that signal, so this would also interrupt sibling tools. It cannot implement “end only the wait.”

4. **High, lifecycle trap.** `agent_end` is not idle. `packages/agent/src/agent.ts`, `processEvents()` and `finishRun()`, deliberately finish awaited listeners before clearing the active run. AgentSession additionally performs retries, compaction and queued continuations in `_handlePostAgentRun()`. Starting the new prompt from an `agent_end` handler can race or reject.

5. **Medium, tracking trap.** InteractiveMode’s `pendingTools` includes tool cards created during streamed argument rendering, before execution. See `syncRevealedStreamingTools()` at `interactive-mode.ts:3374`. Do not use that map as proof that a wait is executing.

## Recommended design

Use a narrowly scoped **wait interruption plus graceful run boundary**, followed by normal prompt submission. Do not change steering or follow-up semantics globally.

### 1. Give executing waits a session-scoped interruption handle

In:

`packages/coding-agent/src/builtin-extensions/pi-subagents/src/runs/background/wait-tool.ts`

Update `registerWaitTool()` so each invocation registers an interruption handle keyed by session identity, agent-run generation and tool-call ID.

The handle must:

- Exist before `waitForPendingLaunches()`.
- Cancel a local wait signal, never the parent signal or child cancellation controls.
- Cover both the launch-registration barrier and `waitForSubagents()`.
- Unregister in `finally`.
- Return an ordinary successful result for a user interruption, for example:  
  `Stopped waiting for a new user message. Background work continues.`
- Preserve existing abort/error behavior when the parent genuinely aborts.

Use a small session-scoped bridge rather than importing the deferred subagent executor into startup or InteractiveMode.

`subagent-wait.ts` already propagates signals through its sleep/wake paths. Its existing `shouldYield` hook is not enough by itself: the registered tool does not supply it, it does not immediately wake the sleep, and yielding does not enforce a fresh agent run.

### 2. Add a run-owned graceful-stop latch

In:

- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`
- Corresponding types in `packages/agent/src/types.ts`

Add a request to end the **current run after its current tool batch**. Bind it to the active run object so it cannot affect a later run.

Reuse the existing `AgentLoopConfig.shouldStopAfterTurn` mechanism where possible. `Agent.createLoopConfig()` currently does not connect a run-owned stop request to it.

Required ordering:

1. Finish all tool results.
2. Persist their normal message events.
3. Emit `turn_end`.
4. Observe the graceful-stop latch.
5. Emit `agent_end` and return without another provider request or queue drain.

Check this explicit stop before unnecessary next-turn preparation. Currently `prepareNextTurn` precedes `shouldStopAfterTurn`.

Do not change the meaning of tool-result `terminate` from “all tools” to “any tool.” Existing tests explicitly protect mixed-batch behavior.

### 3. Let AgentSession own the handoff

In:

`packages/coding-agent/src/core/agent-session.ts`

Introduce one session operation for interactive submission during an interruptible wait.

Its transaction should:

1. Reserve the accepted submission, including images and session generation.
2. Confirm that an interruption handle belongs to the current run.
3. Latch graceful stop **before** releasing the wait.
4. Release the wait.
5. Let the current batch and run settle.
6. Submit through the normal prompt pipeline, without `streamingBehavior`.

Suppress `_handlePostAgentRun()` continuation for that specifically interrupted run. Otherwise compaction or messages queued by `agent_end` handlers can immediately restart it.

A reservation must also prevent notification-triggered prompts from taking the idle slot between settlement and user submission. Preserve notifications as pending context or queued messages; do not drop them.

Use `waitForIdle()` or completion of the owning run operation, not the first `agent_end` event. Do not await idle from an awaited end-event handler.

### 4. Change only the relevant Enter path

In:

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`

At the streaming branch in `defaultEditor.onSubmit`, try the session handoff for ordinary input when an actual wait is active. Otherwise retain existing behavior.

Keep built-in commands and bash handling ahead of this branch. Registered extension commands must still execute immediately rather than interrupting the wait merely because their text starts with `/`.

Input interception and template expansion must run exactly once. Prefer factoring AgentSession’s existing prompt preflight so that an extension-handled input causes no interruption and a transformed input reaches the new prompt intact. Do not call public `prompt()` once to inspect input and again to submit it.

Show accepted handoff input as **Pending message**, only if a delay is visible. Never insert it into `_steeringMessages` or `_followUpMessages`. Render the actual user chat message once through normal message events.

## Invariants and edge cases

- **Background children continue.** No call to async stop controls, broker cancellation or the parent abort controller.
- **Parallel tools finish normally.** Enter releases waits immediately, but cannot safely start a new parent prompt while another tool in that batch is still executing.
- **Multiple waits:** release all active waits belonging to the interrupted parent run. Releasing only one can leave the same batch blocked.
- **Sequential batches:** remaining unrelated calls retain normal execution. A later wait in the same interrupted batch must see the run latch and return immediately, or it can block the handoff again.
- **No orphan tool calls.** Every executed or deliberately skipped call needs its normal result before the new user message.
- **Completion race:** if the wait completes before interruption is acquired, do not cancel a subsequent tool. Resolve against the captured run and re-evaluate ordinary submission routing.
- **Rapid Enter presses:** submissions accepted during the handoff need a FIFO reservation. They must not become steering because the original run is still settling.
- **Images:** retain the complete captured attachment payload with each reservation. Do not reconstruct it from editor text. `clearQueue()` returns strings and is unsuitable for moving these messages.
- **Commands:** built-ins and registered extension commands retain their existing behavior. Skill/template prompts remain normal prompts.
- **Replacement, transfer, shutdown or explicit abort:** invalidate reservations by session generation. Never send old-session text into `/new`, `/resume` or a reclaimed session. Retain or visibly restore unsent input rather than silently losing it.
- **Existing queues:** preserve unrelated queued messages and their established ordering. Specify how they accompany the next run; do not call `clearQueue()` as a shortcut.
- **Noninteractive paths:** leave headless auto-drain unchanged. `pi-subagents/src/extension/index.ts:617` already skips its end-handler auto-drain when `ctx.hasUI`.

“Immediately” must mean immediate acceptance and release of the wait. A fresh provider request still waits for unrelated sibling tools and required lifecycle handlers.

## Focused validation

Add deterministic tests using deferred promises and a scripted provider:

- Wait-only interruption produces one complete tool result, clean end/settled events, then a new normal user prompt.
- No provider continuation or steering/follow-up drain occurs in the interrupted run.
- A parallel non-wait tool retains an un-aborted signal and completes before the new prompt.
- Multiple waits and sequential later waits cannot re-block the handoff.
- Interruption during the pending-launch barrier does not cancel the launch.
- Images survive; extension commands and input handlers run once.
- Completion/Enter races, two Enter presses, background notification arrival, explicit abort and session replacement preserve ownership and ordering.
- UI never displays the handoff message under Steering.
- Background run state remains active after interruption.

Suggested commands, from an isolated checkout of the implementation branch:

```text
cd packages/agent
npx vitest --run test/agent-loop.test.ts test/agent.test.ts

cd ../coding-agent
npx vitest --run test/subagent-wait-startup.test.ts test/suite/agent-session-prompt.test.ts test/suite/agent-session-queue.test.ts test/suite/regressions/6363-agent-settled-event.test.ts test/interactive-mode-status.test.ts

cd ../..
npx tsgo -p packages/tui/tsconfig.build.json
npx tsgo -p packages/ai/tsconfig.build.json
npx tsgo -p packages/agent/tsconfig.build.json
npx tsgo -p packages/coding-agent/tsconfig.build.json
git diff --check
```

Add the new focused test paths to those commands. If the wait description changes, update tool-coverage assertions and the first-request schema fingerprint. No always-injected prompt guidance is needed.