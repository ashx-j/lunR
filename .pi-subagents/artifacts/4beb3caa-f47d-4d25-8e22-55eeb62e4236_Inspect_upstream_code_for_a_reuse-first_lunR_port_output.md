Research complete. No files changed.

## Port recommendation

Use upstream as a code port, not a design reference.

Keep its proven browser core and replace only the Codex-specific boundaries:

- **Port closely:** browser worker, DOM selectors, attachment handling, structural Markdown streaming, turn broker, turn execution/progress, helper line-JSON protocol, browser tests.
- **Adapt:** broker authority from Codex environment metadata to lunR session/tool-inventory snapshots; MCP tool forwarding to lunR tool calls/results.
- **Rewrite:** Responses HTTP server/SSE bridge, Codex request parser, Codex prompt envelope, Codex config integration, native `exec` gateway, delegation protocols, and server lifecycle.
- **Do not port:** Bun runtime bundle, Codex route patching, upstream launcher UI, manual mode, multipart context, Luna checkpoints, and Codex-specific subagent behavior.

lunR already supports this cleanly through `ProviderConfigInput.streamSimple`. A built-in extension can register a custom `"chatgpt-web"` API without first changing `packages/ai`.

## Browser host decision

The upstream Electron host is not decorative. It owns the persistent authenticated partition, tab leases, retained conversations, login windows, control endpoint, and helper process.

Lowest-rewrite path:

1. Port a stripped, lunR-owned Electron browser helper from upstream launcher internals.
2. Keep `browser-host.cjs`, control/descriptor patterns, and browser helper behavior.
3. Remove the React UI, updater, Bun runtime supervisor, and Codex daemon ownership.

A Node plus Playwright host is smaller, but it is a new implementation. It must pass login, popups, attachments, connector behavior, and all target-platform proof gates before replacing Electron.

## Core continuation contract

One ChatGPT submission must stay live while lunR executes tool calls.

- Browser MCP call enters the broker with a short-lived capability.
- Provider emits a normal lunR `toolCall` and ends with `toolUse`.
- Agent loop executes the existing lunR tool and persists its normal result.
- The next provider request identifies the retained browser turn through opaque `responseId` state and delivers results to the pending MCP invocation.
- It resumes reading the same browser response. It must not submit another composer message.

`StreamOptions.sessionId` is insufficient alone. The port needs typed turn ownership, inventory revision, cancellation, remote retirement, and result-delivery bindings.

## Reusable upstream files

| Reuse level | Upstream code |
|---|---|
| Near-direct | `src/adapters/chatgpt-web/browser-worker.ts`, `markdown.ts`, `turn-progress.ts`, `browser-helper-main.ts`, `launcher-helper-client.ts` |
| Adapted core | `turn-broker.ts`, `turn-execution.ts`, compaction transaction and helper IPC tests |
| Rewrite | `index.ts`, `server.ts`, `bridge.ts`, `prompt.ts`, `environment.ts`, `mcp-server.ts` |
| Exclude | Codex integration/setup, Responses parser, native tool gateway, Zero Risk mode, Bun bundle scripts, launcher UI |

The most valuable tests to port first are:

- `browser-worker-contract.test.ts`
- `browser-response-dom.test.ts`
- `chatgpt-web-markdown.test.ts`
- `chatgpt-web-harness.test.ts`
- `turn-broker-lifecycle.test.ts`
- `launcher-helper-client.test.ts`

## Packaging and licensing

- Upstream root license is **MIT**. Retain copyright and MIT text for substantial copied code.
- Browser source is mostly Node-compatible. Bun use is concentrated in upstream runtime/config packaging, not the browser adapter itself.
- Do not ship upstream's pinned Bun 1.4 runtime bundle in lunR.
- `playwright-core`, MCP SDK, Turndown, AJV, tiktoken, and related licenses must be captured from lunR's actual shipped dependencies.
- `openai/tunnel-client` is required for full coding support. Its binary download, hash verification, platform coverage, redistribution terms, and Apache-2.0 notice need a separate packaging proof.

## Suggested migration sequence

1. **Phase 0:** Prove Electron-host reuse versus plain Playwright on Windows x64, macOS arm64/x64, Linux x64. Test login, model selection, images, connector, one read, denied write, approved disposable write, two tool batches, two clients.
2. **Service:** Private profile storage, broker, authenticated local IPC, tunnel lifecycle, single-profile locking.
3. **Tool bridge:** Generic MCP server that forwards exact active lunR tools to the broker. No second tool executor.
4. **Provider:** Custom `streamSimple`, prompt compiler, browser event to `AssistantMessageEventStream` mapper, opaque response/turn binding.
5. **Recovery:** Cancellation, `/new`, model switch, steering/history navigation, compaction, capacity rejection, crash uncertainty.
6. **Release:** Package helper artifacts, notices, docs, and real-account platform validation.

```json
{
  "upstreamCommit": "eaf4f09ae92d4dc4429fa597b0861663138f08f8",
  "researchOnly": true,
  "filesChanged": [],
  "recommendedHost": "lunR-owned stripped Electron browser helper",
  "fallbackHost": "Node plus Playwright only after Phase 0 parity proof",
  "recommendedRuntime": "Node ESM, no upstream Bun runtime bundle",
  "providerIntegration": "custom streamSimple provider registered by a lazy built-in extension",
  "fullCodingRequiresTunnel": true,
  "upstreamLicense": "MIT",
  "readyToImplement": false,
  "requiredProofs": [
    "browser login and connector parity",
    "same-browser-response multi-tool continuation",
    "tunnel and MCP concurrency",
    "cross-platform packaged helper",
    "cancellation and remote turn retirement"
  ]
}
```