# Anthropic OAuth through Claude Code

Status: implementation on `feat/anthropic-claude-code-oauth`; offline validation completed. Live subscription inference, synthetic native evals, and cross-platform qualification remain unperformed. No prerequisites or subscription credentials were installed or accessed during development.

Repository baseline inspected: `e36432c` on `fix/codex-thinking-formatting`. Implement this on a dedicated branch from the chosen integration base, not as part of the thought-formatting change.

## Decision record

The built-in `anthropic` provider stays in place. Anthropic API-key requests keep its current direct Messages API route. Selecting Anthropic subscription OAuth replaces lunR's direct OAuth token transport completely with the official Claude Code CLI transport. There is no direct-OAuth fallback.

Claude Code is installed only after a user explicitly selects Anthropic OAuth and confirms the installer. lunR installation, startup, cache-only creation, model listing for other providers, and unrelated requests never download, probe, or launch it.

The implementation uses upstream code reuse, not a behavior-based TypeScript rewrite:

- Vendor the pinned Python plugin transport under `packages/ai/vendor/hermes-claude-subscription-directsdk/`, preserving its source and MIT license notice.
- Keep `admission.py`, `inert_mcp.py`, and `model_catalog.py` byte-for-byte unchanged. Keep the qualified logic in `directsdk.py`, `directsdk_setup.py`, and their tests, with a small maintained patch set only where Hermes interfaces must become the bridge interface.
- Add a small Python JSON-lines worker and a lazy Node adapter. The worker invokes the vendored transport. The Node adapter maps lunR's `AssistantMessageEventStream` contract to and from that worker. Neither recreates the upstream HTTP admission relay, stream-json replay, native process runner, nor Claude Code protocol in TypeScript.

Python 3.10+ is approved as an on-demand prerequisite for OAuth. The pinned plugin has no PyPI dependencies, but it does require Python. lunR must detect an existing compatible interpreter only when the user chooses OAuth. If missing, offer an OS-level Python install with a separate explicit confirmation that names the installer and external changes. Installation must never run from startup or a request path. Approval of this design does not authorize installing Python in the current development environment.

Use the approved Python reuse approach. A TypeScript translation would be a separate scope change requiring an explicit decision.

## Inspected upstream source

Downloaded, without executing code or installers, to the temporary directory below. This directory is outside the project and is an inspection artifact, not a planned runtime dependency.

- Local inspection copy: `C:\Users\ash\AppData\Local\Temp\lunr-hermes-claude-subscription-f1c1220`
- Pinned source: [`NousResearch/hermes-plugin-claude-subscription-directsdk` at `f1c1220778c7864fe4c1494baf9b1566e7c95bd2`](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/f1c1220778c7864fe4c1494baf9b1566e7c95bd2)
- Plugin catalog description: [Claude Subscription DirectSDK](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk)
- License: upstream `LICENSE` is MIT, copyright 2026 Nous Research and contributors. Vendored copies must retain the full license and an attribution file naming the repository, commit, and local patch series.

The pinned `pyproject.toml` requires Python `>=3.10` and declares no Python dependencies. The code drives the official `claude` executable directly. It does not use the Python Agent SDK despite its DirectSDK name.

### What is reusable unchanged

| Upstream file | Reuse decision | Evidence from inspected source |
| --- | --- | --- |
| `admission.py` | Vendor unchanged | `Admission`, `Handler`, and `Capture` bind a random loopback `/admit/<secret>/v1/messages` route, admit one request under a lock, preserve native authorization headers in memory, forward only to HTTPS or a loopback fixture, capture completed SSE content, and close active sockets on abort. |
| `inert_mcp.py` | Vendor unchanged | Supplies the advertised tool manifest through MCP but returns an error for every `tools/call`. It cannot invoke host tools. |
| `model_catalog.py` | Vendor unchanged initially | Contains qualified aliases, explicit `[1m]` route selection, 200K/1M context metadata, and the Haiku adaptive-thinking exception. Treat its dated rows as fallback metadata only, not a replacement for lunR's catalog. |
| `directsdk.py` transport core | Vendor with narrow bridge patches | `prepare_history`, `request_body`, `Request`, process-group handling, `kill_process_tree`, and `Client._run` implement the hard parts: stream-json replay acknowledgments, private files, native isolation, one-request admission, final-response authority, signed-thinking carrier, streamed text/thinking, tool validation, usage, and teardown. |
| `directsdk_setup.py` | Vendor with narrow bridge patches | `_resolve`, `setup_status`, and `discover_models` provide executable resolution, `claude auth status`, and zero-Messages-request `initialize` discovery through the same admission relay. |
| `tests/test_directsdk*.py` and `evals/*.py` | Vendor alongside source, then run unchanged where interfaces permit | The suite covers Windows launcher lookup, missing CLI, admission, stream capture, replay, schema normalization, process-tree cancellation, discovery, route selection, and synthetic native qualification. The evals use a real native binary only with synthetic loopback upstream responses. |

`__init__.py`, `plugin.yaml`, and `conftest.py` are Hermes registration and discovery glue. Do not vendor them into the runtime package. Preserve them in the upstream-source test fixture or attribution material so the imported version is auditable.

### Exact upstream behavior to retain

The bridge must keep these upstream contracts intact:

1. Every generation creates a private temporary directory, a new `claude -p --input-format stream-json --output-format stream-json` process, and a request-scoped admission relay.
2. Historical user frames use `shouldQuery: false` and require a zero-turn `result` acknowledgment. Only the final user or tool-result frame may query.
3. Native tools, skills, settings sources, slash commands, native persistence, autocompaction, retries, and nonessential traffic are disabled. The upstream command includes `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--max-turns 1`, `--permission-mode dontAsk`, and `--no-session-persistence`.
4. The inert MCP process sees only the current lunR tool manifest. Native `tools/call` always returns denial. lunR executes validated returned calls through its own permission gate and executor.
5. The relay accepts at most one upstream Messages request. A complete first response, usage, stop reason, signed thinking, and tool arguments win even if Claude Code later attempts native recovery. A partial, failed, or malformed first response stays an error.
6. Native stdout is stream-json protocol. It is parsed internally, never printed raw to lunR's UI, RPC, or logs. Diagnostics remain bounded and redacted.
7. The upstream cancellation design remains: a POSIX native process session is killed with `killpg`; Windows uses `CREATE_NEW_PROCESS_GROUP` and `taskkill /F /T`. It also closes active relay sockets.

## Planned architecture

### 1. Typed auth routing in the existing Anthropic provider

Keep the existing `anthropic` provider and `/login anthropic` entry point. Add an explicit non-secret credential variant such as `external_claude_code` rather than storing fake API keys, empty OAuth tokens, or an artificial expiry.

The record contains only a version, manager identifier, resolved executable policy or user-selected path, optional Claude config-directory reference, and a setup/account-discovery fingerprint if available. Claude Code continues to own credentials. lunR must not read, copy, refresh, export, or log its credential files.

| Effective auth | Route |
| --- | --- |
| Explicit genuine `--api-key` or stored/ambient genuine API key | Existing direct Anthropic Messages API |
| Stored external Claude Code connection | Lazy Node-to-Python bridge, then official Claude Code |
| Legacy stored OAuth or `ANTHROPIC_OAUTH_TOKEN` / key-shaped OAuth token | Setup-required migration error. Never make a direct OAuth HTTP request. |

This replaces the current direct OAuth logic in `packages/ai/src/auth/oauth/anthropic.ts`, the OAuth-token branch in `packages/ai/src/api/anthropic-messages.ts`, and OAuth-token precedence in `packages/ai/src/providers/anthropic.ts` / `env-api-keys.ts`. Preserve API-key semantics and other Anthropic Messages-compatible providers.

Routing belongs in one typed helper used by both `packages/ai/src/models.ts` and `packages/coding-agent/src/core/model-runtime.ts`. Preserve it through `stream`, `streamSimple`, completion wrappers, compaction, subagents, gateway, cron, RPC, and SDK calls. Keep process code lazy and Node-only so browser consumers do not import process or relay modules unless they select this route.

### 2. Vendored source and minimal patches

Vendor source at the exact commit with a manifest that records SHA, license, upstream file hashes, and each local patch. Do not copy the source out of the gitignored `hermes-agent/` study tree.

The first patch series must stay narrow and reviewable:

1. **Hermes helper compatibility.** Keep `directsdk.py` intact by supplying two local compatibility modules on the worker import path: `tools.schema_sanitizer.strip_nullable_unions` and `agent.reasoning_effort.clamp_effort`. These replicate only the two functions `directsdk.py` imports. Test their input/output behavior against the upstream plugin tests. If import-path isolation proves brittle, make an equivalent two-call patch in `directsdk.py` and record it as a vendor patch. Do not rewrite the transport.
2. **Bridge lifecycle hook.** Add a small optional callback at `Request.spawn` or `Client._run` that reports the native PID and lifecycle state to the worker. It gives Node a last-resort, targeted cleanup path if the worker becomes unresponsive. This is a patch, not an unchanged upstream file.
3. **Host-shape adapter.** Add `lunr_bridge.py`, separate from vendored upstream files. It maps a versioned JSON-lines request into the chat-completions-shaped inputs expected by `Client`, consumes upstream chunks, and emits lunR-native output events. It owns no relay or Claude protocol behavior.
4. **Setup adapter.** Add `lunr_setup_bridge.py`, also outside the vendored source, to expose `_resolve`, `setup_status`, and `discover_models` through the same JSON-lines protocol. It never runs at first paint.

Keep `admission.py`, `inert_mcp.py`, and `model_catalog.py` hash-checked as unchanged. If a later Claude Code qualification requires a change in one of those files, update the recorded patch, rerun the upstream suite and synthetic evaluations, and describe it as adapted vendored code.

### 3. Node/Python bridge protocol

The Node side is a new lazy `packages/ai/src/api/anthropic-claude-code-bridge.ts` implementation behind the existing Anthropic provider's typed route. It converts `Context` and options into the bridge request and converts bridge events into `AssistantMessageEventStream` events. The bridge owns no authentication and has no fallback to direct OAuth HTTP.

Use newline-delimited JSON on stdin/stdout. Stderr is private, bounded diagnostic data. Every record contains `v: 1`, `requestId`, and `type`.

| Direction | Records | Requirements |
| --- | --- | --- |
| Node → worker | `start`, `cancel` | `start` contains canonical lunR context, selected model, tools, supported options, executable/config policy, and a per-request temp path. Node sends `cancel` before any force-kill. |
| worker → Node | `ready`, `native_started`, `start`, `text_delta`, `thinking_delta`, `complete`, `error`, `cancelled` | `native_started` includes only the native PID/process-group identity needed for emergency cleanup. `complete` is emitted only after the upstream code has validated its one admitted response, complete final usage, and stop reason. |

The worker receives control records on a dedicated stdin reader. It runs `Client.create` independently, so a `cancel` record calls the upstream `Client.cancel()` while the generation is in progress. A Node abort waits for a bounded cancellation acknowledgement and worker exit. If that fails, Node uses the reported native PID only: POSIX `killpg` for the owned session and Windows `taskkill /F /T /PID`. It then kills the bridge process. Never kill by executable name, environment, or an unscoped process search.

The bridge worker runs per request. It may create a child Python process per setup probe, but it does not create a persistent model session. This preserves upstream request isolation and avoids a second conversation store.

The Node converter must:

- start the lunR event stream before deltas;
- preserve text and thinking order, signing data, tool-call IDs, complete arguments, stop reason, response ID, and input/output/cache usage;
- attach the upstream versioned native assistant carrier only after validating that it matches canonical visible content and calls;
- expose tools to lunR only at a validated `complete` boundary. A truncated stream never executes a tool;
- discard stale carrier material after edits, compaction, undo, fork, or incompatible model/provider changes;
- reject unsupported low-level mutations, custom headers/body injection, forced tools, unsafe sampling, and alternate endpoints rather than silently bypassing upstream isolation.

### 4. On-demand setup and dependency policy

At explicit `/login anthropic` subscription selection:

1. Explain that lunR retains tools, permissions, history, compaction, steering, and subagents. Claude Code provides subscription authentication and one generation per lunR request.
2. Resolve a configured executable path or PATH executable, then check the qualified version. Do not do this on startup.
3. Detect Python 3.10+ only here. If absent, offer a separately confirmed OS-level Python installation or cancel setup. Name the installer and external changes before confirmation. It must not install Python through pip, a global configuration, or a silent shell command.
4. If Claude Code is absent, offer `Install Claude Code`, `Use existing executable`, and `Cancel`. The install action needs explicit confirmation and uses current official platform instructions. Re-resolve after install, including known installation locations when PATH is stale. Never elevate without user confirmation.
5. Run the vendored setup bridge's `claude auth status`. Require a signed-in subscription state, not merely API/Console credentials. If interactive and logged out, hand the terminal to `claude auth login`, then recheck. Noninteractive callers get setup instructions only.
6. Run the qualified `initialize` discovery through the vendored admission relay. It must produce zero Messages requests. Cache account-scoped non-secret route metadata separately from API-key catalog data.
7. Atomically store the non-secret external connection record only after all checks pass.

`/logout anthropic` removes lunR's external connection and provider model cache. It does not call `claude auth logout`, modify Claude Code files, remove Python, or uninstall Claude Code.

Print, RPC, SDK, gateway, cron, and subagent callers with missing setup return an actionable setup-required error. They never launch interactive login, installation, or a background probe.

### 5. Security, replay, and lifecycle boundaries

Before spawning Claude Code, reject inherited API/OAuth token injection, `ANTHROPIC_BASE_URL`, alternative cloud backends, and unrestricted native extra-body/identity flags. Report only conflicting variable names. Permit proxies only through an explicit allowlist that preserves TLS verification.

Use upstream private temporary files for full system prompts, native settings, and MCP tool manifests. Do not place them in process arguments or environment values. Delete them after the native process and helper exit.

Translate lunR's context to the upstream canonical history shape. The worker must reject assistant prefill, unknown content, unsupported remote images/documents, unsupported forced-tool behavior, multiple results, and arbitrary headers. Support only the upstream-qualified text, base64 image, tool result, output-limit, stop-sequence, and reasoning behaviors. Retain the upstream tool-name restrictions until an explicit compatibility enhancement is qualified.

Preserve the upstream read-idle deadline semantics. Reset only for meaningful stream-json protocol activity. Bound startup, replay acknowledgement, read-idle, bridge shutdown, and cleanup waits. A normal complete result remains successful despite the upstream-qualified `error_max_turns` / exit-1 tool boundary. Other crashes, partial streams, HTTP failures, and malformed protocol data fail.

### 6. Catalog, usage, and compatibility

Use `directsdk_setup.discover_models()` during explicit setup or a deferred user-requested refresh. Its `initialize` handshake must stay behind the relay and prove zero upstream Messages requests. Use vendored `model_catalog.py` as an explicit fallback only. Do not import Hermes' static model list into lunR's main public API-key catalog or invent context values for future models.

Keep lunR compaction ownership. Map its budget to the actual selected native route and preserve upstream `[1m]` selection. Native autocompaction remains disabled.

Map valid upstream list-price accounting to an estimated API list-price equivalent. Never present it as subscription billing, inclusion, or a plan meter. Missing or interrupted accounting is unknown. Do not inspect Claude Code credential files to estimate plan allowance.

## Implementation sequence and required validation

### Phase 1: vendor audit and bridge contract

- Add the upstream source, full MIT license, attribution, hash manifest, vendor patch directory, and a script that verifies unchanged-file hashes against the pinned commit.
- Add the two narrow Hermes compatibility shims or their recorded two-call source patch.
- Define JSON-lines schemas and malformed-record limits. Test no secrets, prompts, route tokens, or raw authorization headers enter bridge logs.
- Port the upstream tests as vendor tests without changing their assertions where interfaces do not require it. Run their original tests against the vendored source.

Exit: the source provenance is reproducible, unchanged files hash-match, local modifications are enumerated, and bridge messages are versioned and bounded.

### Phase 2: prove the upstream native contract offline

- Run the vendored `tests/test_directsdk.py`, `test_directsdk_admission.py`, `test_directsdk_discovery.py`, `test_directsdk_models.py`, `test_directsdk_replay.py`, and `test_directsdk_setup.py` with fixtures. Do not run live inference.
- Adapt and run `evals/directsdk_admission.py` and `evals/directsdk_cache_wire.py` only against a user-approved local Claude Code executable and a synthetic loopback upstream. They must not access credentials or Anthropic.
- Qualify supported Claude Code versions on Windows, macOS, and Linux. Record the CLI version, source commit, upstream request count, route/context, and cleanup receipt.

Exit: exactly one upstream request per invocation, native tools remain inert, replay acknowledges historical frames, a complete first response survives blocked recovery, and cancellation releases relay sockets and the owned process tree.

### Phase 3: typed routing and lazy Node adapter

- Add the external credential type, resolver, legacy OAuth migration gate, and API-key regression matrix.
- Add the lazy Node bridge adapter and stream converter. Keep the current Anthropic HTTP code for genuine API keys only.
- Cover `stream`, `streamSimple`, completion wrappers, cache-only startup, browser-safe imports, and noninteractive setup-required errors.

Exit: real API keys still take the direct HTTP path. Legacy OAuth never takes it. An external record reaches only the bridge. No Claude Code/Python process starts during unrelated startup or API-key use.

### Phase 4: product setup, discovery, and lifecycle

- Implement explicit Claude Code and separately confirmed Python prerequisite prompts, interactive auth handoff, noninteractive recovery messages, external-record persistence, logout semantics, and account-scoped discovery cache.
- Implement Node-to-worker cancellation, native PID emergency cleanup, concurrent-request isolation, and temporary-file cleanup.
- Add focused tests for cancelled install/setup, stale legacy records, Windows `.cmd` resolution, absent Python/CLI, login failure, setup/logout races, and subprocess cleanup.

Exit: subscription setup is opt-in and reversible at lunR's connection-record layer. Nothing is installed or logged in without a user choice. Cancellation does not leave a bridge, native process, relay socket, or temporary directory behind.

### Phase 5: release qualification

- Run a real, user-authorized subscription smoke only after offline gates pass. Keep it separate from fixtures and record only redacted receipts.
- Exercise normal text, a multi-tool loop, permission denial, plan mode, image input, steering, saved-session resume, compaction, subagent, print/RPC/SDK, and gateway/cron setup-required behavior.
- Test edited and compacted histories separately. Do not claim cross-model signed-history parity unless verified.

Exit: release notes name the qualified CLI version/range, known limits, Python prerequisite, and no-fallback policy. A failed qualification disables subscription requests with an actionable error rather than restoring direct OAuth HTTP.

For implementation changes, use the repository's offline build order: tui, ai, agent, coding-agent, orchestrator, then the coding-agent Node bundle. Run focused AI/coding-agent tests, vendor tests, touched-file Biome, `git diff --check`, first-paint checks, and a relocated package smoke that proves the vendored worker survives public-name rewriting. Never use the AI catalog-generating build command.

## Main code areas

| Area | Intended change |
| --- | --- |
| `packages/ai/src/auth/{types,resolve,helpers,credential-store}.ts` | Add non-secret external connection state and migration gate. |
| `packages/ai/src/providers/anthropic.ts`, `env-api-keys.ts` | Route API keys to existing HTTP and external OAuth to the lazy bridge. Remove OAuth-token precedence. |
| `packages/ai/src/api/anthropic-messages.ts` and OAuth modules | Retire direct OAuth/token exchange and Claude-Code identity spoofing without changing real API-key behavior or compatible providers. |
| `packages/ai/src/api/anthropic-claude-code-bridge.ts` and worker launcher | New lazy Node adapter, JSON-lines protocol, event conversion, cancellation, and redacted diagnostics. |
| `packages/ai/vendor/hermes-claude-subscription-directsdk/` | Pinned MIT source, attribution, unchanged-file hashes, narrow patch series, compatibility shims, and upstream fixtures. |
| `packages/coding-agent/src/core/{model-runtime,auth-storage,model-registry,subscriptions}.ts` | Preserve transport selection, external record storage, setup/discovery status, and no pool fallback. |
| Login UI and focused setup helper | Explicit dependency confirmation, login handoff, noninteractive instructions, and logout wording. |
| Catalog/usage/session persistence | Account-scoped native discovery, actual native context, list-price provenance, and validated replay carrier. |
| Packaging/docs | Package the Python source and worker, never Claude Code or Python itself. Include third-party notices and update shipped provider docs. |

No new agent-facing tool is required. Tool schemas and first-request inventory remain unchanged unless implementation deliberately changes them.

## Risks and approved dependency decision

The direct-reuse path retains a second runtime. Its upside is substantial: the qualified 623-line upstream transport, 201-line admission relay, inert MCP server, process cleanup, replay behavior, and test/eval suite remain Python rather than being reimplemented from descriptions. Its cost is Python detection, packaging, cross-language cancellation, and vendor-patch maintenance.

The upstream Claude Code interfaces are version-sensitive. `--max-turns 1` alone is insufficient, which is why the admission relay is non-negotiable. Treat failure of one-request admission, native isolation, replay acknowledgement, or process cleanup as a release blocker.

The user approved Python 3.10+ as an Anthropic OAuth prerequisite and offering a separately confirmed OS-level installation if missing. Claude Code installation is also approved as an explicit setup option after OAuth selection. Neither dependency is bundled or installed during lunR installation/startup. Implementing the setup option did not authorize installation or live account use during development.

Out of scope: bundling Claude Code or Python, reading/importing Claude Code credentials, API-key behavior changes, a direct-OAuth fallback, native Claude Code tool execution, a persistent native session, multi-account rotation, a generic external-agent framework, unqualified model/context claims, and automatic Python or Claude Code setup during lunR install/startup.

## Sources

- [Hermes plugin catalog and implementation description](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk)
- [Pinned upstream repository at `f1c1220778c7864fe4c1494baf9b1566e7c95bd2`](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/f1c1220778c7864fe4c1494baf9b1566e7c95bd2)
- Upstream files inspected in full: `LICENSE`, `README.md`, `pyproject.toml`, `plugin.yaml`, `__init__.py`, `admission.py`, `directsdk.py`, `directsdk_setup.py`, `inert_mcp.py`, `model_catalog.py`, `conftest.py`, all `tests/test_directsdk*.py`, and both `evals/*.py`
- [Official Claude Code installation documentation](https://code.claude.com/docs/en/setup)
- [Official Claude Code headless documentation](https://code.claude.com/docs/en/headless)
- [Official Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- Local architecture references: `packages/coding-agent/docs/providers.md`, `packages/coding-agent/docs/interactive-startup.md`, and `packages/coding-agent/docs/model-catalog.md`
