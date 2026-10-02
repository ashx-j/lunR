# Native ChatGPT Web support for lunR

Status: plan only. No feature code has been imported or implemented.

Revised 2026-09-22. Replaces the earlier design that proposed rebuilding too much of the upstream implementation.

Source baseline: `miuuyy/codex-chatgpt-web` 5.0.8, commit `eaf4f09ae92d4dc4429fa597b0861663138f08f8`. The repository was fetched and inspected by a standard-tier agent. lunR integration points were inspected on the 0.2.21 checkout, branch `fix/codex-thinking-formatting`.

## Decision

**Import the existing upstream implementation and adapt it to lunR. Do not rebuild the feature from its design.**

Keep its working browser automation, Electron login/profile handling, turn broker, MCP server, retained conversations, and compaction machinery. Keep its Bun runtime and packaging where they avoid a porting rewrite. Add a small lunR driver around the production engine, then connect that driver to lunR's existing provider and tool loop.

Native means users configure and use the feature through lunR. It does not require every component to run inside lunR's Node process. An internal, lunR-managed Electron/Bun companion is acceptable and is the default plan. Users must not install Codex, operate the upstream launcher separately, or maintain a separate proxy configuration.

Replacing Electron with plain Chromium, migrating Bun to Node, replacing the MCP server, or inventing a new compaction implementation are not prerequisites. Consider them later only for a demonstrated problem, with separate approval.

## Agreed product scope

- A distinct `chatgpt-web` provider in `/model`, using the ChatGPT website and the user's available account routes.
- Setup inside lunR, with a dedicated browser window and persistent login profile.
- Automatic operation. No manual paste-and-send mode in the initial user experience.
- Full coding through lunR's existing tools, permissions, history, images, cancellation, compaction, and subagents.
- Windows, macOS, and Linux in the first release. Validate Windows x64, macOS arm64 and x64, and Linux x64, matching upstream's current release targets. Additional architectures need separate evidence.
- No changes to existing Codex/OpenAI login, provider routes, or the general browser tool's profile and permissions.

Keep unused upstream functionality in the imported source when deleting it would add churn. Do not activate or advertise manual mode, experimental larger-context transport, native Codex passthrough, or Codex configuration management. Internal dependency code may remain without becoming a lunR feature.

## What the inspection established

Upstream already has a development driver that calls the production engine without a running Codex application or a Responses HTTP listener. It is the starting point for this integration, not a suggestion to write another engine. [1][2]

`src/dev-chat/driver.ts` already:

- Converts its conversation into a Responses-shaped request.
- Calls `responseRequest` directly with an injected adapter factory.
- Observes live output through `onAdapterEvent`, even with `stream: false` in the private request.
- Supplies tool results in the next request to continue the existing browser response.
- Calls `compactRequest` to use production compaction.

Its simulated tools are not usable production tools. Replace that outer-driver responsibility with lunR's real tools and canonical history, while retaining the production functions it calls.

Relevant existing interfaces:

| Upstream interface | How lunR will use it |
| --- | --- |
| `responseRequest` in `src/server.ts` | Call inside the companion with the production adapter factory, `rememberState: false`, and event/identity callbacks. No public Responses server. |
| `compactRequest` in `src/server.ts` | Drive upstream's existing structured compaction and map the outcome into lunR session history. |
| `createChatGptWebAdapter` in `src/adapters/chatgpt-web/index.ts` | Keep the production adapter; inject the companion-owned broker. |
| `createLauncherDevAdapter` in `src/dev-chat/driver.ts` | Reuse its construction pattern for helper paths, private state directories, and adapter creation. |
| `codex_tool_inventory` and `codex_tool_call` in `mcp-server.ts` | Initially retain the generic exact-name inventory/call path, supplied with lunR's current tool definitions. |

Important constraint: structured retained compaction checks `broker instanceof TurnBroker`. The adapter, concrete `TurnBroker`, turn-session registry, and compaction transactions must live in the same companion process. Putting only a `RemoteTurnBroker` beside the adapter would lose this path. The development driver proves a useful integration pattern, not complete lunR compatibility.

## Source import and maintenance policy

Use a tracked source import, not a gitignored study checkout, runtime Git clone, floating npm dependency, or downloaded unmodified upstream application.

Proposed location: `packages/chatgpt-web-companion/`, containing the imported runtime, launcher sources, build assets, and tests. Keep upstream-relative paths intact where practical. This is a separately built companion package; it must not pull Electron or Bun into lunR's normal Node import graph.

1. Import the pinned source and its license as a distinct baseline commit on a new feature branch based on the intended integration branch. Do not include unrelated working-tree changes.
2. Record upstream URL, commit, version, imported paths, excluded generated artifacts, and applied patches in `UPSTREAM.md` inside the companion package.
3. Keep lunR-specific entry points and translation code separate from imported files where existing injection points allow it.
4. Make necessary upstream edits small and attributable. Preserve original file names and test organization; avoid formatting-only changes, bulk renaming, and unrelated modernization.
5. Retain build inputs and the appropriate lockfiles. Do not copy `node_modules`, user profiles, credentials, local configuration, or release binaries into Git.
6. Bring future upstream fixes across by comparing against the recorded baseline, applying the relevant commits, and running the retained upstream tests plus lunR boundary tests.

The source import is implementation work, not part of this planning task. Any later publication of adapted source must preserve license notices and exclude private data.

## Code reuse map

The default for these files is to keep the existing code, not translate its algorithms into new lunR implementations.

| Upstream files or directories | Keep | Necessary lunR adaptation |
| --- | --- | --- |
| `src/adapters/chatgpt-web/browser-worker.ts`, `markdown.ts`, model selection and attachment helpers | DOM automation, logical turn binding, attachments, structural output extraction, completion observation | Helper/config paths, connector identity, and narrowly scoped host integration. No replacement browser worker. |
| `browser-helper-main.ts`, `launcher-helper-client.ts`, helper build script | Existing line-JSON helper protocol and browser process behavior | Package locations and lunR-owned startup. Do not repurpose this protocol as the new provider-driver protocol. |
| `launcher/electron/browser-host.cjs`, `browser-state.cjs`, `control-server.cjs`, profile/login modules | Persistent Electron partition, login windows/popups, tab leases, retained browser state | Dedicated lunR profile identity, bootstrap entry, private descriptor paths, and owner lifecycle. |
| `launcher/electron/runtime*.cjs`, runtime installation/verification, process-tree and drain helpers | Existing process supervision, versioned runtime extraction, integrity checks and shutdown behavior where applicable | Launch a lunR driver instead of the Codex daemon; disable upstream route installation and independent product updates. Reuse before replacing. |
| `src/adapters/chatgpt-web/index.ts`, `turn-execution.ts`, `turn-progress.ts`, `turn-broker.ts` | Production request orchestration, queued calls, response continuation, replay handling, activity accounting and completion fences | Trusted lunR identity/environment input, lifecycle hooks, and tool-inventory binding. Do not rewrite the adapter. |
| `src/adapters/chatgpt-web/mcp-server.ts`, `mcp-observation.ts` | Existing MCP server and generic inventory/call transport | Present lunR tools, parameterize connector labels, and prevent Codex-only actions from being advertised as callable lunR operations. |
| `src/server.ts`, `src/responses/`, `src/bridge.ts`, `prompt.ts` | Production request/compaction handlers, parser, prompt compiler and required response conversion | A private normalizer supplies their expected input. Reject non-Web routes before dispatch; do not start the public server or native forwarding path. |
| `compaction-handoff.ts`, `compaction-transaction.ts`, `compaction-continuation.ts`, related checkpoint code | Existing checkpoint transaction, result settlement and physical retirement ordering | Feed canonical lunR history and commit compatible lunR compaction entries. Keep model-specific checkpoint logic when required by a supported route. |
| `src/tunnel.ts`, config/setup/doctor modules | Tunnel acquisition, verification, readiness checks and applicable setup checks | Use lunR-owned configuration and invoke only setup paths that do not edit Codex or install unrelated services. |
| `scripts/build-runtime-bundle.ts`, launcher packaging scripts, license assets | Electron/Bun runtime distribution and verification approach | Build a lunR companion artifact, with only required entry points and notices for actual shipped dependencies. |
| `tests/`, applicable `launcher/tests/` | Existing browser, helper, broker, compaction and lifecycle tests | Add lunR fixtures and run retained tests with their existing runner. Do not convert the whole upstream suite to Vitest. |

Upstream's React launcher/settings code may be retained temporarily where the login or setup host needs it. Do not make deleting it a prerequisite to the first working integration. The final entry point is lunR, and any retained window is a lunR-managed setup/login window, not a separately installed product.

Codex route journals, `config.toml` edits, encrypted delegation protocols, native API passthrough, the simulated DEV tool executor, and upstream autostart/updater commands must never run in the lunR integration. Enforce that through entry-point/configuration restrictions and focused tests, rather than indiscriminate source deletion.

## Target architecture

```text
lunR Node CLI / SDK / session
    |
    | custom provider stream + authenticated private driver protocol
    v
persistent lunR-managed Bun companion
    +-- lunR request/history normalizer
    +-- upstream responseRequest / compactRequest
    +-- upstream createChatGptWebAdapter
    +-- concrete TurnBroker + retained turn sessions + compaction state
    |
    +-- upstream Electron browser host and browser helper
    |
    +-- upstream MCP server + supervised OpenAI tunnel client
                                      |
                                      v
                          ChatGPT connector and browser response
```

The diagram groups responsibilities, not a mandatory new process for every box. Preserve upstream's working subprocess layout where possible. In particular, do not relocate the adapter and concrete broker into separate processes.

The persistent companion serves the effective lunR agent directory/profile and multiplexes terminal and subagent clients. Do not spawn it for every model request: module-global session and transaction state must survive tool-result continuations.

No provider traffic is sent to a new public HTTP endpoint. Private Responses-shaped objects remain an internal compatibility format. They do not require a Codex account, Codex installation, or changes to other providers' base URLs.

## New code and targeted changes

### 1. Native provider registration

Add a lightweight built-in registration for `chatgpt-web` using coding-agent's existing custom `streamSimple` support in `ProviderConfigInput`. Keep a distinct API/provider identity.

Register cached model metadata before the first provider request, but load the companion client lazily. Ordinary lunR startup must not start Electron, Bun, the tunnel, or account discovery. The generic AI package should not acquire browser dependencies.

Integrate `/login`, `/logout`, `/model`, `/refresh`, supported thinking levels, and status reporting. Authentication to the local companion is separate from browser cookies and the OpenAI tunnel key. The current API-key configuration path can carry a real local IPC credential with a browser-setup label; do not invent OAuth tokens to imitate a browser login. Prove this fit against model availability and logout before broad UI changes.

### 2. Private lunR driver

Adapt the outer orchestration pattern from `src/dev-chat/driver.ts`, not its simulated executor or DEV instructions. Add a narrow, versioned protocol between Node and the persistent companion for response rounds, compaction, cancellation, retirement, status, and draining.

Use authenticated local IPC suitable for multiple clients on all supported OSes. A named pipe or Unix socket is the default; reuse upstream local transport utilities where they fit. Do not expose raw arbitrary module calls or enable native Codex forwarding through this protocol.

The driver calls the existing `responseRequest` and `compactRequest` functions inside the companion. Stream `AdapterEvent` values through IPC. With `rememberState: false`, lunR remains the canonical transcript owner; the companion retains only the transport state needed for active and retained conversations.

### 3. History and authority normalizer

Translate lunR context into the existing parser's supported subset: instructions, input messages, image content, active function tools, tool choice, reasoning options, and stable private thread/turn metadata.

- Allocate an opaque thread identity per lunR session and a new turn identity per top-level user turn. Preserve that turn identity through every tool-result continuation.
- Preserve stable message and call IDs, ordering, and result types. Do not rebuild different IDs every time the provider is called.
- Construct the required environment item and its adjacency to the active user item from trusted lunR state. Never parse authority out of model-written text or repository content.
- Translate the effective workspace and permission information honestly. Do not copy the DEV driver's unrestricted/simulated environment defaults into production.
- Supply the current active tool inventory on each round, including child restrictions. Tool availability cannot be recovered from stale history.
- Bind internal identities to the authenticated local client. A caller-supplied cwd or thread ID alone does not confer access to another session.

Keep the upstream prompt compiler and environment store. Add a narrow trusted-input hook if their Codex assumptions cannot represent lunR accurately. Do not synthesize fake Codex rollout files. Missing or ambiguous authority must fail closed, not trigger recovery from the user's real Codex installation.

### 4. Event and tool-result translation

Map the existing event types into `AssistantMessageEventStream`:

| Upstream event | lunR behavior |
| --- | --- |
| `thinking_delta` | Thinking-summary delta, without claiming hidden reasoning access. |
| `text_delta` | Text delta, preserving the distinction between commentary and final output where lunR supports it. |
| `tool_call_start`, `tool_call_delta`, `tool_call_end` | Ordinary lunR tool-call events with stable IDs and complete validated arguments. |
| `done` with `tool_use` | Finish this provider round as `toolUse`, leaving the browser response alive. |
| Final `done` | Finish the lunR assistant response with the appropriate stop reason and usage. |
| Error, incomplete, or cancellation | Map to a genuine error/aborted/length outcome; never turn incomplete work into success. |

The existing agent loop then applies permissions and hooks, executes the real tool, and records its result. The companion never runs a second executor.

On the next round, translate `ToolResultMessage` records into the upstream parser's tool-output items. Upstream's existing outstanding-result handling resolves the waiting MCP invocations and continues the same browser response. Do not submit another ChatGPT message just because lunR called the provider again.

Keep the existing generic MCP inventory/call path first. Internal names such as `codex_tool_call` can remain while proving compatibility. Branding or connector schema changes must be deliberate and versioned; they are not a reason to replace the protocol. Codex-only convenience actions must be unavailable unless explicitly and safely mapped to an actual lunR tool.

### 5. Retained chats, compaction, and lifecycle

Retain upstream's multi-message browser conversation behavior. Do not replace it with a fresh Temporary Chat after every answer.

Connect lunR lifecycle events to the existing cancellation, activity-fencing, drain, and physical-retirement operations. Cover Escape, session shutdown, `/new`, model/effort changes, `/undo`, `/edit`, history navigation, steering, and account changes. Invalidate only the owning session, not another terminal using the same companion.

Reuse `compactRequest` and upstream's structured checkpoint flow. Integrate it through lunR's compaction hooks or a narrowly scoped session change. The existing between-tool-batch check currently applies only to `openai-codex`; model metadata alone will not give the new provider the required behavior.

Define and test the conversion from upstream checkpoint/replacement-history output to lunR's summary, kept-message boundary, and compaction metadata. Preserve completed tool calls/results and model-switch compatibility. Do not maintain a second independent canonical history that disagrees with lunR.

A successful handoff must settle outstanding tool results, obtain the checkpoint through its restricted control capability, wait for the upstream retirement transaction, and commit a coherent lunR history boundary. Failure must leave a recoverable known state. Existing upstream fallback paths may be reused, but not used to hide a broken retained-compaction integration.

A transport crash after a write can leave delivery uncertain. Preserve recorded local outcomes and never automatically replay a side effect or an ambiguously accepted browser submission. No claim of exactly-once execution across crashes.

### 6. Subagents and concurrency

Keep lunR's subagent implementation and its permissions. Each Web child gets its own bound turn/session through the shared companion. Do not copy upstream's Codex delegation protocols.

Preserve upstream's five-tab safety limit and capacity failure behavior initially. This is an upstream local policy, not a universal OpenAI quota. Apply it across clients without changing lunR's unrelated-provider fanout limits. Retained idle tabs still matter to capacity; use upstream's lease rules rather than claiming that every completed response frees its tab.

Test API-to-Web, Web-to-API, Web-to-Web, concurrent terminals, and full-capacity failures. Do not add an unbounded queue that can deadlock when waiting parents occupy every browser slot.

Verify long `subagent_wait`, approval, and shell operations through the retained MCP/tunnel code. Upstream has Codex-specific wait handling, which does not automatically cover lunR's tool names and semantics. Adapt its bounded-wait mechanism only where needed to avoid transport starvation, preserving the public lunR tool contract. This is an integration proof gate, not permission to rebuild the MCP server.

## Setup and user-facing behavior

Proposed entry points:

| Entry point | Behavior |
| --- | --- |
| `/login chatgpt-web` | Guided setup using the imported login and verification flows. Open a lunR-managed window where browser interaction is necessary. |
| `/model` | Account-discovered Web routes, separate from Codex models. |
| `/refresh` | Refresh the configured account's supported routes without changing an active turn. |
| `/logout chatgpt-web` | Revoke this provider's local authority and clear its login/availability after resolving active work. Do not affect Codex. |
| `lunr chatgpt-web setup` | Terminal entry to the same setup flow. |
| `lunr chatgpt-web status` / `doctor` | Reuse upstream diagnostics with lunR ownership and redacted output. Confirm before live message/write probes. |
| `lunr chatgpt-web disconnect` | Disable use and drain owned processes without silently deleting the login profile. |

Reuse setup checks for browser authentication, account capabilities, tunnel readiness, and connector attachment. Separate the applicable setup operations from upstream's Codex installation side effects. Use a dedicated lunR connector identity with an explicit schema version; do not overwrite an existing Codex connector.

Explain these prerequisites rather than silently falling back:

- This is unofficial browser automation. UI changes can break it, and account/workspace restrictions still apply.
- Full coding requires usable MCP connector/write permissions as well as model access. The upstream consumer-model list does not prove full tools work for every Plus or Pro account. OpenAI's linked help page describes full write support as a beta rollout for Business, Enterprise, and Edu; verify the actual account at setup. [3]
- The OpenAI tunnel needs a separate runtime key with Tunnels Read and Use permissions. Browser login does not supply it. Never request a permanent admin credential for the running service or promise universal availability/free usage. [4]
- The user handles passwords, MFA, passkeys, and challenges in the private browser. No cookie import or automated challenge bypass.

Use upstream's account discovery and route mapping rather than replacing them with a static model list. Cache only for the verified account/workspace. Respect each fixed browser mode's effort restrictions; Codex Fast mode does not apply. Report estimated tokens as estimates and unavailable cost/plan usage honestly. Preserve upstream composer and context budget checks.

## Security boundaries to preserve and adapt

Carry over upstream's capability lifecycle, call correlation, replay checks, completion fences, browser profile isolation, and runtime integrity verification. [1]

Required lunR-specific checks:

- Current lunR permissions and argument validation remain authoritative for every actual tool execution, including children and read-only sessions.
- Tool inventory changes and owner/account invalidation revoke or reject stale requests.
- Capabilities, local credentials, cookies, and tunnel keys never enter normal session history, exported transcripts, project files, command-line arguments, or diagnostic logs.
- Authenticate companion control/driver access. Keep browser control endpoints private and preserve upstream verifier checks; do not add a public debugging port for convenience.
- Restrict private files to the current user with Unix modes or Windows ACLs. Keep provider secrets out of tool/subagent environments and protect credential/profile paths from routine file tools.
- A compromised local user or arbitrary shell access remains outside the protection offered by file modes. Document this rather than claiming a complete sandbox.
- Unexpected ChatGPT approval prompts fail closed. Do not enable upstream's optional automatic approval behavior without a separate user decision.
- Reject non-`chatgpt-web/*` internal model routes before `responseRequest`. That function can otherwise forward native Codex requests.
- A disabled integration does not start the browser, tunnel, updater, or an OS login service. Explicitly test that upstream initialization cannot edit Codex files.

## Packaging and runtime ownership

Keep lunR's main CLI on Node. Ship the adapted upstream engine as an optional platform companion built from the pinned source, retaining Electron and its pinned Bun runtime initially. No system Bun or separately installed upstream application should be required.

Reuse upstream's runtime manifest, extraction, checksums, launcher process handling, and platform package recipes where possible. Change artifact identity, entry points, profile location, and update ownership, not the browser/runtime stack.

The companion is acquired through an explicit lunR setup action. Publish/version it alongside compatible lunR releases, verify trusted artifact metadata before extraction or launch, and reject an incompatible driver protocol. Normal npm installation and cold startup must not download or start it. Support an explicit local artifact path for testing and offline installation after verification.

Use a private subtree under the effective lunR agent directory, not upstream's default home and never the user's Codex home. Keep existing installed upstream profiles untouched. Reuse profile locking/single-owner behavior for multiple lunR clients and add client/session ownership where needed.

Preserve single ownership of the tunnel. The official tunnel client forbids overlapping stdio instances for the same tunnel ID, including during restart. Drain before replacement. Use lunR's release/update policy rather than allowing the upstream updater to replace the managed engine independently. [4]

Windows checks include paths with spaces, hidden subprocess startup, profile locking, and process cleanup. macOS checks include both architectures, supported OS versions and signing/Gatekeeper requirements. Linux checks include display/system-library requirements and durable runtime paths. Do not ask users to disable platform security or silently run privileged installers.

Upstream is MIT licensed. Preserve its copyright/license and provenance. Generate notices for the actual shipped Electron, Bun, browser, tiktoken, libnotify, and other dependencies as applicable. Preserve OpenAI tunnel-client's Apache-2.0 notices when redistributed and verify the supported distribution path. Existing upstream packaging is useful code, not proof that a differently branded lunR artifact passes signing, licensing, or installation checks.

## Delivery plan

### Phase 1: import and establish the baseline

- Create the tracked companion source import with license, provenance and upstream tests.
- Build the original browser/runtime stack from the pinned source in an isolated environment.
- Run the applicable upstream tests before changing integration code and record existing failures separately.
- Add the minimal lunR profile/bootstrap configuration. Disable Codex setup, native forwarding, autostart and independent updates before invoking setup.

Acceptance: the imported stack builds; its login/browser host works in isolation; the execution path cannot mutate a real Codex configuration. No production profile or installed lunR change.

### Phase 2: prove the driver with the existing engine

- Adapt the DEV driver's request construction and adapter-factory usage into a persistent production lunR driver.
- Keep the concrete broker, adapter, turn sessions and compaction in that process.
- Add the private driver protocol and context/tool/event conversion.
- Demonstrate a real read, denied write, approved disposable write, and another tool batch in the same browser response through lunR's existing executor.
- Demonstrate a second user turn using upstream's retained conversation, then a retained compaction checkpoint mapped into lunR history.

Acceptance: no replacement browser worker, broker, MCP server, prompt engine, or compaction engine was needed. If a real incompatibility demands a larger change, identify the exact blocker and obtain approval rather than silently reverting to a rebuild.

### Phase 3: native product integration

- Add lazy built-in provider registration and login/model/refresh/status flows.
- Connect imported setup and diagnostics to lunR; retain useful upstream UI only inside the managed setup/login experience.
- Integrate account-scoped discovery, auth availability, supported effort display and local credential cleanup.
- Add cancellation, session/history invalidation, shutdown and compaction hooks.

Acceptance: the feature is usable entirely from lunR entry points; Codex and other providers stay unchanged; default startup starts no companion.

### Phase 4: concurrency and recovery

- Prove multiple terminals share the host safely and one client's shutdown does not cancel another.
- Prove all mixed-provider and Web-to-Web subagent combinations, including long waits and capacity failure.
- Exercise interrupted delivery, browser/tunnel loss, owner crashes, expired capabilities, context overflow and retained-compaction failure.
- Verify print, RPC and SDK callers. Unattended gateway/cron use requires an already configured, usable browser host and must fail without attempting interactive login. Do not start or modify the user's gateway during development.

Acceptance: no duplicate side effects, lost pending calls, cross-session authority, or indefinite capacity/transport waits in the tested cases. Uncertain crash outcomes are reported rather than replayed.

### Phase 5: cross-platform distribution and release

- Produce companion artifacts using adapted upstream build/package scripts.
- Validate fresh lunR installation plus explicit setup on every target OS/architecture.
- Test relocation, artifact integrity, compatible upgrades, disconnect, and active-work drain.
- Update shipped docs, licenses, troubleshooting, and repository state notes. Update tool-coverage and prompt inventories only where actual agent-facing tools or schemas change.

Acceptance: release as an opt-in experimental provider only after the real-account platform gates pass. Merge, publication, and updates to the user's installed CLI require separate approval.

## Verification strategy

Retain upstream tests instead of writing replacements for copied algorithms. Initial candidates include `browser-worker-contract`, `browser-response-dom`, `chatgpt-web-markdown`, `chatgpt-web-harness`, `turn-broker-lifecycle`, helper-client tests, and the existing compaction/launcher suites. Confirm exact paths in the imported baseline.

Add focused lunR boundary tests for:

- Canonical messages/images/tool schemas to upstream request mapping, including stable identity and trusted environment placement.
- Every adapter terminal outcome, duplicate/replayed events, full tool-result batches, and denied tools.
- Inactive/removed tools, child permission restrictions, cross-session identities and revoked capabilities.
- Same-browser-response continuation, retained second user turn, and checkpoint-to-lunR compaction conversion.
- Cancellation, `/new`, history edits, model changes, owner loss, long MCP calls and full-tab capacity.
- Setup without Codex configuration writes, no native forwarding, secret redaction, and no optional-runtime startup for other providers.

Use imported fixtures/fake transports in CI and run the existing Bun tests in the companion job. Use Vitest for lunR translation and integration tests. Real browser/account checks are manual, consented release gates with disposable workspaces and sanitized evidence. Do not store credentials or private prompt captures in the repository or upload them as CI artifacts.

Run lunR's offline tui → ai → agent → coding-agent → orchestrator builds and coding-agent's Node bundle, then focused tests, touched-file lint, `git diff --check`, first-paint/first-request checks, and fresh packaged-install checks. Build the companion separately with its retained toolchain. Never use the AI package's catalog-generating build as validation.

## Remaining proof gates

These are implementation questions, not reasons to redesign the imported stack in advance:

1. Can the trusted lunR normalizer satisfy the existing environment/identity contract across resumed sessions without Codex rollout files?
2. Can the existing generic MCP tools expose all intended lunR tools while disabling irrelevant Codex-only actions?
3. Can the existing retained checkpoint be committed into lunR's canonical history without maintaining conflicting transcripts?
4. Do long lunR waits require a narrow adaptation of upstream's Codex-specific wait handling?
5. Can the imported supervisor/bootstrap support multiple lunR clients without accidentally activating upstream installation/update behavior?
6. Does the configured account support the required tunnel, connector and write actions, and do packaged artifacts pass every supported platform's installation checks?

The first working milestone should answer these using the imported production engine. Do not spend that milestone building an alternative browser service.

## Sources

1. [Upstream source at the pinned commit](https://github.com/miuuyy/codex-chatgpt-web/tree/eaf4f09ae92d4dc4429fa597b0861663138f08f8), [architecture](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/docs/architecture.md), [security model](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/docs/security-model.md), and [MIT license](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/LICENSE).
2. Concrete reuse seams: [DEV driver](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/src/dev-chat/driver.ts), [production request handlers](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/src/server.ts), [production adapter](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/src/adapters/chatgpt-web/index.ts), [MCP server](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/src/adapters/chatgpt-web/mcp-server.ts), and [Electron browser host](https://github.com/miuuyy/codex-chatgpt-web/blob/eaf4f09ae92d4dc4429fa597b0861663138f08f8/launcher/electron/browser-host.cjs).
3. [OpenAI developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Retrieved during planning on 2026-09-22; recheck account availability during setup.
4. [Official OpenAI tunnel-client](https://github.com/openai/tunnel-client). Retrieved during planning on 2026-09-22; pin and verify the actual shipped version.
5. lunR integration references: [custom providers](packages/coding-agent/docs/custom-provider.md), [provider composer](packages/coding-agent/src/core/provider-composer.ts), [agent loop](packages/agent/src/agent-loop.ts), [compaction](packages/coding-agent/docs/compaction.md), [startup](packages/coding-agent/docs/interactive-startup.md), and [auth types](packages/ai/src/auth/types.ts).
