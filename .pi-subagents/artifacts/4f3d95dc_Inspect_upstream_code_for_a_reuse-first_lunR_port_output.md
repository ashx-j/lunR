## Focused follow-up: retain the upstream engine behind a lunR driver

The upstream DEV driver already proves the right shape. It calls the production adapter in-process, without starting a Responses listener or altering Codex routing.

`src/dev-chat/driver.ts`:

- Builds a private Responses-shaped request.
- Calls `responseRequest(...)` directly.
- Uses `onAdapterEvent` for live reasoning/text/tool events.
- Feeds tool results back in the next request.
- Calls `compactRequest(...)` for the production compaction path.
- Uses `createChatGptWebAdapter(...)`, not a DEV-specific browser implementation.

That is the minimal-change route for lunR.

### Concrete internal topology

```text
lunR Node provider stream
  -> authenticated private stdio/pipe protocol
  -> persistent Bun companion
       -> responseRequest / compactRequest
       -> createChatGptWebAdapter + TurnBroker
       -> upstream Electron launcher/browser helper
       -> upstream MCP server + tunnel client
```

No public Responses proxy is needed. `startServer()` is not needed.

The Bun companion must remain persistent for a profile, not be spawned per model request. Its module-global `chatGptTurnSessions`, `TurnBroker`, browser worker state, retained launcher tabs, and compaction transactions are the state that makes tool continuation and retained compaction work.

## Existing injectable seams

### Production request runner

`src/server.ts:responseRequest` is already injectable:

```ts
responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory?: (provider: CodexProviderConfig) => ProviderAdapter,
  options?: {
    rememberState?: boolean;
    onAdapterEvent?: (event: AdapterEvent) => void;
    onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
  },
): Promise<Response>
```

Use it in the Bun companion as the DEV driver does:

- `rememberState: false`, because lunR owns canonical history.
- `onAdapterEvent`, streamed over private IPC and mapped directly to lunR's `AssistantMessageEventStream`.
- `onTurnIdentity`, for auditing and cancellation ownership.
- `stream: false` in the internal Responses payload. Events still arrive live through `onAdapterEvent`; no SSE bridge is required.

`src/server.ts:compactRequest` has the same adapter-factory seam and turns an internal `compaction_trigger` request into upstream's normal compaction machinery.

### Adapter and broker injection

`src/adapters/chatgpt-web/index.ts:createChatGptWebAdapter` already accepts:

```ts
createChatGptWebAdapter(provider, {
  broker?: TurnBrokerOwner,
  zeroRiskManualControl?: ChatGptZeroRiskManualControl
})
```

`src/dev-chat/driver.ts:createLauncherDevAdapter` is the closest reusable construction template. It injects a broker, helper path, private diagnostics directory, thread-environment state, and checkpoint state, then returns a normal production `ProviderAdapter`.

For lunR, retain the automatic mode only. Exclude Zero Risk at the driver boundary rather than deleting upstream code.

## What the lunR normalizer must provide

The companion should convert lunR's canonical `Context` into the small Responses subset consumed by `parseRequest()`:

- `model`
- `instructions`
- `input`
- `tools`
- `tool_choice`
- `parallel_tool_calls`
- `reasoning`
- `stream: false`
- `prompt_cache_key`
- `client_metadata["x-codex-turn-metadata"]`

`src/dev-chat/driver.ts:requestBody`, `currentTurnItems`, `environmentContext`, and `turnMetadata` are concrete templates.

The generated metadata needs:

- an opaque companion `thread_id` per lunR session
- a new opaque `turn_id` per top-level lunR user turn
- the same `turn_id` across every tool-result continuation
- a trusted effective workspace/permission snapshot
- a stable `prompt_cache_key` per lunR session

The driver must generate the synthetic `<environment_context>` itself from lunR session state. Do not extract authority from model text or replayed history.

This works with upstream's existing `ChatGptThreadEnvironmentStore` in `src/adapters/chatgpt-web/thread-environment.ts`, because it accepts a structurally adjacent environment item plus canonical metadata and stores only authority, never tool declarations. The current tool inventory remains request-scoped.

## Tool bridge: retain it first

Do not rewrite `mcp-server.ts` for the first port.

`src/adapters/chatgpt-web/mcp-server.ts` already exposes generic:

- `codex_tool_inventory`
- `codex_tool_call`

Those resolve exact names from the current `ChatGptTurnEnvironment.tools` snapshot, validate freeform versus structured payloads, invoke the broker, deduplicate/revoke failed calls, and account for activity leases used by completion fencing.

lunR can supply its active tools as ordinary upstream `function` definitions. The existing special `codex_exec`, `codex_apply_patch`, and gateway code simply remain unused unless lunR deliberately maps tools to those shapes.

Small later adaptations are naming-only:

- `Codex Native` strings in `prompt.ts`
- `Codex` labels in `mcp-server.ts`
- connector display identity/configuration

Those are not reasons to rebuild the MCP protocol.

## Event/result conversion

The companion maps the existing `AdapterEvent` union, not Responses SSE:

| Upstream event | lunR output |
|---|---|
| `thinking_delta` | thinking stream event |
| `text_delta` | text stream event |
| `tool_call_start/delta/end` | normal lunR tool-call stream events |
| `done(stopReason: "tool_use")` | lunR `toolUse` completion |
| `done(stopReason: "stop")` | lunR final completion |
| `error` / `incomplete` | lunR error/aborted completion |

On continuation, lunR sends canonical assistant tool calls and `ToolResultMessage`s back to the companion. `src/adapters/chatgpt-web/index.ts:currentToolResults` already finds result IDs from parsed history and delivers them to the waiting broker invocation. No new tool executor is needed.

## Retained turns and compaction

Keep them. Do not default to a fresh browser chat.

The upstream engine retains a tab/conversation when automatic full mode has a launcher descriptor:

- `index.ts:startRuntime` computes `conversationKey`, `retainConversation`, and `prepareResume`.
- `turn-execution.ts:chatGptTurnSessions` preserves the active browser response through tool batches.
- `compaction-handoff.ts` settles outstanding results, fences tool activity, requests the structured checkpoint, and retires the old retained conversation only after physical settlement.
- `server.ts:compactRequest` is the existing entry point for the private compaction protocol.

### Critical placement requirement

**High severity:** retained structured compaction requires the actual in-process `TurnBroker`.

`index.ts` sets:

```ts
const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
```

and rejects automatic structured compaction when this is absent.

Therefore the Bun companion must own:

- `TurnBroker.forSocket(...)`
- `createChatGptWebAdapter(..., { broker })`
- `responseRequest` / `compactRequest`
- `chatGptTurnSessions`

lunR's Node process may communicate with that companion over private IPC, but it must not own only a `RemoteTurnBroker` while the adapter runs elsewhere. That would preserve ordinary tool calls but disable the retained compaction path.

## Concrete blockers and risks

- **High, `src/dev-chat/driver.ts:createLauncherDevAdapter` and `transport.ts:startDevChatTransport`:** DEV proves the in-process adapter path, but assumes an already-running launcher and an already-ready launcher-owned tunnel. It does not bootstrap either. lunR needs a small companion bootstrap around the existing launcher/runtime ownership, not a new browser or tunnel implementation.
- **High, no existing driver IPC:** `responseRequest` is callable in-process only. Add one narrow Bun stdin/stdout or named-pipe wrapper around `responseRequest`, `compactRequest`, abort, drain, and status. Do not expose HTTP or reuse browser-helper IPC, which controls only the browser worker.
- **High, `environment.ts:extractChatGptTurnEnvironment`:** the driver must create stable synthetic turn metadata and place a trusted environment item immediately before the active user item. A changing `turn_id`, an untrusted XML source, or reordering that pair breaks retained execution identity or fails authority validation.
- **Medium, `prompt.ts`:** initial source import can preserve its current Codex wording and token names internally. Before user-facing release, make a narrow branding pass. Rewriting the prompt compiler's context/attachment/compaction algorithms is unnecessary and would increase drift risk.
- **Medium, `server.ts:responseRequest`:** it forwards non-`chatgpt-web/*` models to native Codex. The companion must expose only its routed models and reject all others, never allow this fallback path to run.
- **Medium, packaging:** source import first is feasible because the adapter itself is mostly Node-style TypeScript, but upstream launcher/runtime build expects Bun and Electron. Keep that as an internal companion artifact. Do not turn it into a user-installed upstream product or import its Codex setup/configuration path.