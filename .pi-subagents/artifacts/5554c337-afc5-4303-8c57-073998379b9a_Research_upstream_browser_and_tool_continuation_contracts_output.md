## Findings

### Reusable design pieces

- **Turn broker queue and capability lifecycle.** `src/adapters/chatgpt-web/turn-broker.ts` provides a generic local socket/pipe broker: opaque per-turn tokens, a claimed binding, queued tool requests, at-least-once batch replay, result correlation by `callId`, cancellation, and completion fencing. This is the strongest reusable piece for a native lunR implementation.
- **Long-lived turn session.** `src/adapters/chatgpt-web/turn-execution.ts` has `ChatGptTurnSession`, append-only text/trace feeds, outstanding-call tracking, exact-round event replay, and per-session `runExclusive()` serialization. The session mechanism ports well, but its identity derivation is Codex Responses-specific.
- **Progress and terminal race protection.** `src/adapters/chatgpt-web/turn-progress.ts` separates browser-visible completion from MCP activity. Its tool-batch acknowledgement plus completion fence prevents a browser-complete DOM state from winning while a tool invocation is active. Reuse this contract if lunR runs the browser worker out of process.
- **JSONL helper boundary.** `browser-helper-main.ts` and `launcher-helper-client.ts` define a compact request/event protocol for browser work, cancellation, prompt selection, progress mirroring, and completion-fence acknowledgements. This can be retained with a lunR-owned process host.

### MCP call to outer provider tool-call flow

1. The adapter starts one browser run and registers a turn capability with the broker.  
   `src/adapters/chatgpt-web/index.ts` (`prepareWith`, `broker.register`); `turn-broker.ts` (`register`).

2. ChatGPT calls the local MCP server. The MCP handler claims the turn, then sends an `invoke` request to the broker and waits on its promise.  
   `src/adapters/chatgpt-web/mcp-server.ts` (`withClaimedTurn`, `invoke`); `turn-broker.ts` (`dispatch("invoke")`).

3. The adapter waits on `broker.nextToolBatch()`. When it receives requests, it records tool activity, waits until the browser has observed the tool boundary, stores the batch as outstanding, then emits provider events:
   `tool_call_start`, `tool_call_delta`, `tool_call_end`, then `done { stopReason: "tool_use", endTurn: false }`.  
   `src/adapters/chatgpt-web/index.ts` (`emitToolBatch`, turn loop around `setOutstanding`).

4. On the provider continuation, the adapter finds the same `ChatGptTurnSession` via a stable execution key. It reads the returned outer tool results, calls `broker.completeTool(token, callId, result)`, and clears each outstanding call.  
   `src/adapters/chatgpt-web/index.ts` (outstanding-result branch); `turn-execution.ts` (`markResultDelivered`).

5. `completeTool` resolves the original blocked MCP `invoke` promise. ChatGPT receives that MCP result in its already-running browser turn and continues. **There is no new ChatGPT composer submission for a normal tool continuation.**

### Native lunR implications

- **Critical integration constraint:** lunR's provider bridge must support a `tool_use` terminal response, preserve a stable turn/session identity across the tool-result continuation, and route all returned tool results back to the same pending browser session. A stateless provider adapter cannot use this mechanism.
- **Critical concurrency constraint:** one browser surface is serialized per native thread/owner (`turn-execution.ts`, `getOrCreateAfterOwnerRetirement`), and upstream hard-caps the account at five concurrent browser tabs (`concurrency.ts`, `MAX_CHATGPT_BROWSER_TABS = 5`). lunR's unlimited subagent fanout needs an integration-level queue or it will fail launches once five ChatGPT turns are active.
- A tool batch may be parallel, but the next continuation must contain **all** outstanding results. Partial batches throw. Only one unresolved batch may exist per browser session.  
  `turn-execution.ts` (`setOutstanding`); `index.ts` result-count check.
- Subagent waits are deliberately forced to 30 seconds so a long `wait_agent` call does not monopolize the shared MCP transport.  
  `mcp-server.ts`, `CHATGPT_WEB_AGENT_WAIT_POLL_MS`.
- The completion fence is required when MCP tools are enabled. It blocks browser completion until broker activity and pending invocations are both empty. Keep it if worker, MCP server, and adapter run separately.  
  `turn-broker.ts` (`beginCompletionFence`, `commitCompletionFence`); `turn-progress.ts`.

### Dependencies not worth copying directly

- **Codex-specific:** `index.ts`, `environment.ts`, prompt compilation, identity/replay keys, output events, tool schemas, raw `exec` gateway, and compaction all depend on Codex Responses fields such as `_rawBody.input`, `thread_id`, `turn_id`, `_compactionRequest`, and Codex tool-result messages.
- **ChatGPT-specific:** `browser-worker.ts` depends on ChatGPT DOM selectors, Temporary Chat, effort/model controls, connector mentions, tool approval UI, backend request paths, browser message limits, and Markdown extraction. It is the browser automation implementation, not a portable provider layer.
- **Electron-specific:** `launcher/electron/browser-host.cjs` owns Electron `WebContentsView`, persistent partitions, CDP exposure, visible/hidden tab leasing, and control-server state. lunR can replace this with a Node-launched persistent Chromium profile plus a small local control service.
- **Bun-specific:** upstream requires Bun 1.4.0 and uses `bun:test` / `Bun.sleep` (`package.json`, `tests/*`). lunR should port runtime code to Node rather than adopt Bun.

### Compaction

Upstream's retained-conversation compaction is not a first-pass transplant. It needs complete Codex native history, stable thread/turn identity, a retained ChatGPT tab, a one-shot broker control token, and strict physical-retirement ordering.  
`compaction-handoff.ts`, `compaction-transaction.ts`, `turn-execution.ts`.

For lunR, start with browser-message budget checks and normal lunR compaction before submission. Add retained in-browser compaction only after the continuation/session bridge is proven. Upstream also distinguishes browser transport limits from model context limits in `browser-worker.ts`; compaction must honor both.