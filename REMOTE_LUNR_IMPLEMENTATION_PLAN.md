# Built-in remote lunR implementation plan

Status: superseded as the immediate implementation plan, 2026-09-24. Read `../lunR/REMOTE_DESKTOP_HANDOFF.md` for the latest decisions, built experiments, verification, and reuse research. The sequence is now finish TUI, then desktop app, then an optional separately downloaded remote host. Both the original built-in cross-platform plan and the intermediate Windows/npm-first milestone below are historical reference. Implementation remains paused.

## Reuse research before implementation

The user subsequently authorized investigating replacements and is willing to discard the remote-hosting prototype if that saves meaningful work. Source findings are saved in `../lunR-remote/.pi-subagents/artifacts/remote-reuse-research.md`. T3 Code's standalone server plus its existing terminal is a plausible browser-based replacement for the first workflow; PtyKit is a candidate library for a lunR-native host. Neither was run or adopted. Compare these options before continuing the custom implementation below. Preserve the existing branch until a replacement is verified; do not treat this as permission to remove unrelated lunR features. Implementation remains paused.

## Resume here: agreed narrower first delivery

- Windows hosting through the normal npm-installed lunR. Standalone executables and macOS/Linux hosting are deferred.
- Start the host manually first. Windows sign-in startup follows later.
- First milestone: start a task, close the attached terminal, reopen lunR, and reconnect to the same live worker and task. Use two local terminals before adding networking.
- Next milestone: connect the user's laptop to that Windows host, with application authentication intact. The laptop OS has not been established. Tailscale is the preferred first VPN option; automated WireGuard setup is deferred.
- Preserve the existing TUI and host-owned execution. Closing a client detaches; it does not abort work or grant approvals.
- Keep the architecture extensible, but defer the all-platform installer/service matrix, standalone/Bun work, automated VPN installation, and other-host-OS support from the next implementation milestone.
- The original broad Phase 0 requirements below do not require more Bun or cross-platform packaging work before implementing this Windows/npm milestone.

### Saved implementation state

- Work is paused. No active subagents remain. The todo list was cleared at the user's request.
- Implementation worktree: `C:/Users/ash/Desktop/PROJECTS/lunR-remote`, branch `feat/remote-lunr`, last pushed commit `5aa58d4210a7c5f2163d632653363dd24cc50839`.
- Prerequisite PR: https://github.com/ashx-j/lunR/pull/108. It is open and unmerged, and does not implement remote hosting. No release was made.
- The original checkout and its unrelated local changes remain separate. This plan and `.pi-subagents/` are private, untracked artifacts and must stay out of public commits.
- Remote host, secure pairing, remote transport, recovery, and service/setup integration have not been implemented. The branch contains isolated feasibility probes, packaging prerequisites, and CI.
- Final full Phase 0 validation run https://github.com/ashx-j/lunR/actions/runs/36053877314 passed all 12 jobs at `5aa58d4`: six native OS/CPU targets on Node 22.19 for candidate/product npm, plus those six on Node 24 with compiled standalone validation. There was no diagnostic-label bypass in this run.
- Node/npm proofs use pinned `@lydell/node-pty@1.2.0-beta.15` with prebuilt platform packages. The standalone experiment uses Bun 1.4.2 built-in Terminal, without a bundled PTY addon. Neither is an implemented production remote-host backend yet.
- Tests prove actual compiled-host-owned TUI first paint, settings input, live worker identity across detach, and a real repaint at the measured render width. Other isolated probes cover detached tool completion, pending dialogs, same-size repaint, and synthetic image submission. Do not claim every scenario was tested in every backend combination.
- Actual signed/downloaded archive policy, musl, real VPN/off-LAN attachment, login services, and production remote security were not verified. These remain future release checks, not reasons to repeat the now-deferred standalone investigation for the Windows/npm milestone.
- An earlier general CI comparison found 105 failing test headers on this branch versus 107 on its master baseline, with no branch-only failures. This is separate from the passing remote validation matrix and was not a claim that the whole repository test suite passes.
- No installed CLI, personal session, VPN, service, or security setting was modified by the agent. At pause, no running process matched the task's PTY/Phase 0 fixture identifiers; unrelated Node processes were left alone.

### Next session

1. Read this scope update and inspect the implementation worktree before editing. Preserve unrelated work and the private artifacts.
2. Implement the bounded Windows/npm local-host milestone, reusing the proven PTY candidate and existing runtime/TUI. Do not restart the broad packaging investigation.
3. Verify live task continuity across detach/reattach with an isolated scripted provider and profile. Keep authentication and permission enforcement intact.
4. Then address the actual laptop client and one VPN path. Obtain explicit consent for installed services, VPN/firewall changes, or replacing the daily-driver CLI.

For this task the user requested heavy-tier code writers, limited GPT-6 Astra at medium reasoning for the hardest work, and permitted standard-tier Astra at low reasoning for focused review. Conserve usage through bounded assignments and focused verification. Do not repeat passing matrices for unrelated fixture changes. Do not merge or release without explicit authorization. The earlier multi-day estimate was not grounded enough; give milestone-based progress rather than another unsupported duration estimate.

Original planning provenance: prepared 2026-09-23 from three heavy, read-only investigations and official platform documentation. The rest of this document describes the broader original design.

## Short version

Ship hosting and connecting in the normal lunR installation on Windows, macOS, and Linux. Enabling hosting makes a background lunR process own sessions. The local terminal and a laptop then attach to the same running session. Closing either terminal only detaches it.

Preserve the real TUI first. Add a structured session channel alongside terminal attachment so a future app can embed the terminal and offer graphical views without creating a second agent engine. Support Tailscale and self-hosted WireGuard through the same connection protocol.

The difficult work is session ownership, terminal compatibility, safe reconnection, and installer lifecycle. Sending text over a network is the smaller part.

## 1. Agreed requirements

- One product, package, and `lunr` executable. No host-only edition or separate server download.
- Windows, macOS, and Linux can each host, connect, or do both.
- Hosting is included but network exposure and login autostart require setup consent.
- Once hosting is enabled, ordinary local interactive launches use hosted sessions automatically. There is no separate remote-only workflow to remember.
- A session started locally can be continued from another device while the same model request, tool process, or subagent keeps running.
- Hosting starts at user sign-in and survives terminal closure.
- Preserve the existing TUI, commands, built-in widgets, and terminal extension behavior.
- Guide both VPN choices and automate supported installation/configuration steps after approval.
- No paid hosting or lunR cloud account required. Tailscale still has a third-party coordination/relay dependency; WireGuard can avoid it when the network allows direct access.
- The future app manages this same CLI and supports terminal and graphical views. Building that app is not part of this implementation.

### Explicit limits

- Closing a client is not stopping the host. Logging out of the host OS, sleeping, rebooting, and losing power are different events.
- First release starts at sign-in, not before sign-in. Post-logout operation is not a universal guarantee.
- A worker that remains alive can continue the exact computation. A crashed worker can restore saved history, not an interrupted process or an external side effect.
- No migration of computation from the home PC to the laptop, no automatic repository sync, and no automatic local execution if a remote host is unavailable.
- Existing pre-upgrade standalone sessions cannot become hosted mid-turn simply by opening their files. Finish or pause them, then reopen under the host. All new hosted sessions support live handoff.
- This grants access to a coding agent with the host user's authority. Project selection is not a filesystem sandbox.

## 2. What the repository already provides

Paths below are relative to `packages/coding-agent/` unless stated otherwise. Findings describe planning constraints, not a general code review.

| Existing area | Reuse | Required change |
| --- | --- | --- |
| `src/core/agent-session.ts` | Agent execution, queues, compaction, streaming events | Expose coherent live state and distinguish event delivery from persistence |
| `src/core/agent-session-runtime.ts` | Session creation, replacement, shutdown hooks | Worker owns it, never an attached client; rebind after replacement |
| `src/core/session-manager.ts` | JSONL history, branches, session identity | Single writer; persist initial identity and selected leaf for recovery |
| `src/modes/interactive/interactive-mode.ts` | Actual TUI, commands, dialogs, rollback integration | Separate detach from shutdown; add hosted control and device-operation bridge |
| `src/modes/rpc/{rpc-mode,rpc-types,rpc-client}.ts` | Typed command semantics and agent events | Not a ready-made remote server; pipe EOF currently shuts down the runtime |
| `src/core/permissions.ts` | Existing permission policy | Keep enforcement host-side, with persistent pending requests and one responder |
| `src/core/extensions/{types,runner}.ts` | Extension lifecycle and UI | Keep executable components on host; do not serialize or download extension code to client |
| `src/gateway/` | Bot routing and some lifecycle patterns | Preserve Telegram/Discord behavior; its independent chat sessions do not attach to TUI sessions |
| `src/core/cron/`, `src/builtin-extensions/lunr-cron.ts`, `src/gateway/cron.ts` | Job storage and execution | Coordinate scheduler ownership across processes |
| `src/builtin-extensions/pi-subagents/` | Async execution, watchers, result delivery | Keep original worker/session identity while clients come and go |
| `src/cli/{install-cli,update-cli}.ts`, `src/core/install-layout.ts` | Installation paths and npm update | Add service-aware update, uninstall, and repair |
| `src/core/install-features.ts` | Existing setup flow | Existing chat autostart is only a recorded option, not an installed login service |
| `src/startup/{launch-routing,interactive-view}.ts`, `src/main.ts` | Early dispatch and fast first paint | Route hosted/remote launches without loading agent services on clients |
| `packages/tui/src/{terminal,terminal-image,tui}.ts` | Terminal negotiation and rendering | Attachment-specific capabilities and a full repaint on handoff |

Two important differences from a simple RPC wrapper:

1. Session JSONL does not contain the running model request, tool process, pending dialog, or all volatile state. `get_entries(since)` is a history cursor, not a live-event cursor.
2. Current RPC deliberately omits custom TUI components, editors, footers, and some commands. A structured-only client would require a substantial UI split before it preserved today's experience.

## 3. Architecture decision

### Persistent host with a TUI worker per active workspace session

```text
One normal lunR installation on every device

Local lunr client ---- private local connection ----+
                                                   |
Laptop lunr client -- Tailscale or WireGuard + TLS --+-- lunr background host
                                                   |       |
Future app --------- same connection ---------------+       +-- worker A: TUI + AgentSessionRuntime
                                                           +-- worker B: TUI + AgentSessionRuntime
                                                           +-- session registry, device authorization
```

The host is an execution mode inside the existing package. It runs under the signed-in user, not administrator/root. Each worker retains the existing TUI and runtime inside a host-owned pseudo-terminal. On Windows this uses ConPTY; on macOS/Linux it uses a PTY.

The host owns the terminal handles even with zero attached clients. It drains worker output continuously so a closed laptop cannot fill a pipe and stall a build. Attached clients own their physical terminal only.

Separate workers are justified by existing process-global extension bridges, permission handlers, working directories, and terminal state. They also contain crashes. They are not security sandboxes.

### Why retain host-side rendering first

The initial option was a local TUI renderer controlling a remote runtime. Inspection showed that would require separating much of `InteractiveMode` and redesigning executable extension UI before feature parity.

For this release, keep the real TUI running on the host and transport its terminal presentation. This is an integrated lunR connection, not an SSH/tmux dependency or separate host product. The laptop still handles connection management and physical-device operations locally.

Add structured commands and events alongside terminal bytes, not by parsing ANSI output. A later graphical app uses that channel. A native/local renderer may follow, but it is not required for the first complete product.

### Dependency gate before implementation

Evaluate `node-pty` as the PTY/ConPTY adapter and `ws` as the WebSocket implementation. Neither is a declared direct dependency in the inspected coding-agent package. Pin accepted versions and regenerate installer/shrinkwrap data through existing tooling.

Do not assume `node-pty` means effortless installation. Prove prebuilt support for the supported Node/OS/CPU matrix, Windows runtime requirements, macOS signing behavior, and npm/standalone package paths. Normal users must not unexpectedly need Python, C++ build tools, or Xcode just to install lunR.

If suitable packaged PTY binaries cannot be shipped and verified, stop at the feasibility gate. Revisit an injectable terminal backend versus the larger local-renderer split explicitly. Do not silently substitute a stripped-down RPC interface. No Electron dependency belongs in the CLI just to support a future wrapper.

### Startup and ownership rules

- Remote-disabled installations retain ordinary local behavior and do not launch a listener at startup.
- Remote-enabled hosts route normal interactive sessions through the background host from creation.
- Clients connecting to another machine do not load local model credentials, project extensions, LSP servers, or agent tools for that remote session.
- Keep print/RPC/SDK behavior compatible. Do not silently daemonize scripting or child-agent invocations.
- Offer a clearly labelled standalone recovery mode. It cannot attach live from another device.
- A host lock plus authenticated health handshake prevents duplicate hosts for the same agent directory. Do not rely on a PID file alone.
- The registry binds an opaque hosted-workspace ID to its worker. The active conversation UUID can change on `/new`, `/resume`, or `/fork`; publish that replacement explicitly.
- Lock session files against concurrent writers, including conflicts with standalone processes. A second open attaches or refuses, rather than loading another writable copy.

## 4. User experience and proposed commands

Command names are proposed, not existing commands.

| Entry | Behavior |
| --- | --- |
| `lunr remote setup` | Guided host/client setup in the existing installation |
| `lunr remote connect <name>` | Connect to a paired host and choose or reopen a session |
| `lunr remote status` | Local host, saved hosts, connection and version status |
| `lunr remote doctor` | Redacted installation, permissions, network, and service diagnostics |
| `lunr remote start` | Start enabled local hosting |
| `lunr remote stop` | Explain active work and confirm before shutting it down |
| `lunr remote devices` | List/revoke devices through authenticated local administration |
| `/remote` | Same setup/host/session choices inside the TUI |
| `/detach` | Leave the hosted session running |

All normal workflows should be available in menus. These CLI commands also support diagnostics and the future app.

After first setup, remember a chosen default destination and last attachment. Show the machine name and host project path persistently. A remote connection failure must show a reconnect screen with an explicit local-work option, never quietly run the task on the laptop.

Closing the terminal, `/exit`, or the usual client quit action detaches a hosted session. Provide a separate explicit stop-session action with confirmation when work is active. Escape keeps existing abort and double-Escape subagent-stop meanings; disconnect never synthesizes Escape or Ctrl+C into the worker.

First release permits one interactive controller per session. Another client can request takeover with a clear warning; the old controller becomes detached. Multi-viewer observation is a later compatible addition, not a release dependency. This avoids conflicting viewport sizes, editor input, and approval responses.

## 5. Connection and protocol

### Transport

Use a private local socket or named pipe for local clients, with user-level permissions/ACLs and an authenticated handshake. Use TLS WebSockets for network clients, bound only to selected VPN interfaces. Both VPN choices use the same application protocol.

A VPN disappearing must disable its listener, not cause fallback to `0.0.0.0`. Handle interface address changes explicitly. Support configured VPN-routed subnets only as an explicit setup choice with equivalent firewall restriction.

Use separate logical channels over the connection:

- Control and typed session commands.
- Ordered session events and snapshots.
- Terminal output and controller input.
- Bounded attachment/artifact transfers.

All envelopes carry protocol version, request/event identity, host identity, worker generation, and target workspace/session identity where relevant. Runtime-validate external input with existing schema tooling. Do not expose arbitrary object method calls.

### Minimum structured contract

- Handshake, capabilities, list hosts/sessions, create, attach, detach, take control, stop.
- Session snapshot, active conversation change, history page/cursor, live events.
- Prompt, steer, follow-up, abort, model/thinking changes, supported navigation actions.
- Pending interaction list and response.
- Explicit upload and artifact download.
- Version/capability errors with a useful upgrade path.

Extract shared dispatch from existing runtime/TUI/RPC boundaries where needed. Do not create a second implementation of permissions, tool execution, prompt expansion, or session navigation.

### Coherent reconnect

1. Authenticate and validate compatibility before disclosing session data.
2. Acquire a new controller generation and invalidate the previous controller.
3. Worker captures a snapshot at event sequence N while buffering subsequent events.
4. Client installs the snapshot and consumes events after N.
5. Gaps or expired replay buffers trigger a fresh snapshot, not guessed reconstruction.
6. Terminal attachment negotiates capabilities and requests a complete repaint. Do not replay arbitrary old terminal bytes into a newly initialized terminal.

Snapshots include active conversation/leaf, current partial response, running tools, queues, pending approvals, model/permission state, and supported UI status. Never include provider tokens or wholesale settings/auth files. Record the distinction between live state and committed history.

Bound output queues and replay retention by bytes/time. A slow client is resynchronized or disconnected without blocking the worker. Detached workers continue consuming events and subagent notifications, but need not broadcast animation frames.

### Command and keyboard reliability

Typed mutating commands use stable client request IDs and an acceptance ledger. Record accepted identity before dispatch and return the previous result for retries. Accepted, running, completed, rejected, and outcome-unknown are distinct states.

Raw terminal input has its own controller-generation sequence numbers and acknowledgments. Reject stale generations and duplicate chunks. Never replay old input into a new worker or dialog. A lost acknowledgment with an uncertain worker-delivery outcome produces a state refresh and warning, not a blind retry.

Built-in prompt submission should cross the shared typed command path so a lost connection cannot duplicate a submitted task. Arbitrary custom editor input cannot claim exactly-once side effects across a crash. Preserve the live draft where possible and report uncertainty instead.

No protocol can guarantee exactly-once shell side effects after a process dies between executing a command and recording its result. Do not advertise that guarantee.

## 6. Terminal and extension compatibility

The first implementation milestone must demonstrate the actual existing TUI, not a replacement transcript viewer.

- Negotiate terminal dimensions, keyboard protocol, color and image support per controller.
- On handoff, invalidate cached terminal capabilities, reset physical-terminal modes safely, resize the PTY, and force full repaint.
- Audit process-environment capability caching in `terminal-image.ts` and direct `process.stdout.columns` reads in subagent rendering.
- Keep custom tool renderers, component widgets, custom editors, extension dialogs, and terminal-input hooks executing on the host.
- Keep theme and smooth-streaming settings host/session-owned initially. They are not silently reinterpreted as per-device preferences.
- Clipboard, viewport, local terminal protocol, and local downloads belong to the client.
- Implement an explicit worker-to-client request for image paste. The client reads its clipboard, uploads bounded bytes, and the worker retains normal `[image_n]` behavior. `/paste-image` follows the same path.
- File references and autocomplete refer to host files. Upload is an explicit operation, not an attempt to open a laptop path on the PC.
- Browser/editor launch requests need an explicit client operation or a documented host-only fallback. Never silently launch a hidden host editor and leave the user waiting.
- The client must not blindly execute remote OSC clipboard writes, arbitrary URL opening, or filesystem directives. Define a streaming terminal-control filter that allows negotiated display functions and routes sensitive physical-device effects through confirmed requests.
- Restore the client's terminal modes on orderly detach, errors, and connection loss.

A future graphical client renders supported typed dialogs and messages. Arbitrary JavaScript extension components retain the terminal view as their compatibility path. Do not execute downloaded host extensions on the laptop to imitate them.

## 7. Permissions, identity, and persistence

### Device trust

VPN membership is not authorization to run lunR tools.

Use a TLS-protected application connection with a pinned host identity and per-device credentials. Initial pairing displays/verifies the host fingerprint through a trusted local setup screen or transferred pairing bundle. Require explicit host approval, expiry, and rate limiting. Never disable TLS verification as a pairing shortcut.

Use standard TLS and an established certificate-generation implementation, not custom encryption. Confirm the certificate-generation dependency and rotation path during the feasibility gate. Store device credentials outside ordinary settings, protect temporary files before writing secrets, use POSIX permissions and Windows user ACLs, and keep secrets out of URLs, process arguments, logs, and service definitions.

Pairing grants owner-level session access for the first release. Fine-grained multi-user sharing is out of scope. Device revocation closes its live connections and invalidates control immediately. Remote settings cannot create a new trusted device or expose a public listener without local administration.

Validate all session and artifact IDs host-side. Do not forward arbitrary client-supplied file paths to RPC switch/import/export operations. Artifact downloads use authorized handles, bounded sizes, and safe filename handling; symlinks and traversal must not bypass that policy.

### Pending decisions

Core permission and plan decisions belong to the worker. Give requests stable IDs and controller-generation checks. Accept only one valid response. Detaching retains the pending request and the next controller sees it.

Default core approvals wait for the controller to return, unless the underlying operation is cancelled. Existing extension dialogs with explicit deadlines retain those deadlines and reject/cancel on expiry. A worker restart invalidates pending decisions; it cannot replay an old approval into a new operation.

The terminal and structured UI paths must resolve the same pending request, not maintain separate permission handlers. No automatic switch to auto mode because a client disconnected.

### Recovery storage

Keep existing JSONL as canonical conversation history. Add a small versioned host metadata/journal store under the resolved agent directory for registry state, active-leaf checkpoints, command acceptance, and device records. Reuse atomic-file and locking patterns where correct; do not add a database just for convenience.

Persist a session's identity before acknowledging creation. Record active-leaf changes even without a new message. A worker generation distinguishes restarted computations from the same live session.

After host/worker failure, recover history and mark interrupted work explicitly. Reconcile detached child outcomes by existing stable ownership IDs. Never automatically rerun an uncertain shell command. A host crash may interrupt workers whose PTYs it owns; uninterrupted host-process crash recovery is not a first-release promise.

## 8. Background work ownership

### Subagents

Keep the original session owner, watcher, supervisor channel, and completion delivery alive in the worker. Client IDs never replace subagent owner IDs. A completed child must wake/continue the host parent as today even with no attached UI.

Test completion, child questions, cancellation, and resume while detached. Preserve native supervisor ownership and existing acknowledgment/deduplication behavior. No new per-client intercom broker.

### Cron

Do not add a third scheduler beside the existing TUI and Telegram/Discord paths.

Introduce one scheduler owner per agent directory with a cross-process ownership lock and lock-protected job-store writes. When hosting is enabled, hosted TUI workers register their session execution/delivery callbacks with the host scheduler instead of each starting a scheduler. Preserve bot delivery through a registered gateway executor, with no public bot API or duplicate scheduler.

When hosting is disabled, existing TUI/gateway scheduling remains available under the same ownership rule. Define unavailable-origin behavior explicitly; a job targeting a missing live session must not silently run in another project.

Retain/document the current execution policy. This work must prevent duplicate dispatch caused by adding hosting, not promise exactly-once external effects or redesign all cron features.

## 9. Guided networking setup

The wizard follows inspect, propose, approve, apply, verify. It records what lunR owns and can undo its own incomplete changes without uninstalling the user's existing VPN.

### Common flow

1. Choose allow connections, connect to a computer, or both.
2. Explain that paired devices can use the host's coding-agent authority.
3. Detect existing VPN installation/configuration without printing keys.
4. Choose Tailscale or WireGuard. Reuse an existing working connection.
5. Present installation, network, firewall, and autostart changes before applying them. Elevate only the operations that need it, never the agent process.
6. Pair lunR devices and save a friendly host name.
7. Verify application authentication and round-trip attachment from the second device. A localhost check alone does not verify remote access.
8. Let the user choose remembered destination and login autostart. Explain host sleep behavior.

Use official installers or trusted OS package managers. Validate downloads/signatures where available; no arbitrary download-and-run scripts. Installation must be resumable after denial, reboot, or network failure. Ordinary npm install must not silently enable hosting or install a VPN from a postinstall hook.

### Tailscale

- Detect/install the supported OS distribution, then open its normal authentication flow.
- Discover the home host through user-approved tailnet information or explicit hostname.
- Verify VPN connectivity and lunR port access. Give narrow access-control guidance rather than automatically rewriting an entire tailnet policy.
- Bind lunR to the selected Tailscale address; no dependency on Serve and never enable Funnel.
- Report direct versus relay connection when available, without treating relay as failure.
- Avoid embedding reusable Tailscale auth keys in config or install commands.

### Self-hosted WireGuard

- Preflight reachable public IPv4/IPv6, router access, and possible CGNAT before asking the user to complete a long setup.
- Offer existing-tunnel reuse and guided new-tunnel setup.
- Generate each private key on its own device. Exchange public keys and endpoint/configuration information explicitly.
- Configure narrow peer routes and `AllowedIPs`; do not make this a full-device VPN by default. Warn about route/subnet conflicts.
- Support a reachable router endpoint or a host endpoint with explicit router forwarding and host firewall guidance. Handle changing public addresses through a user-chosen hostname/DDNS arrangement where needed.
- Keepalive can preserve a NAT mapping, not overcome an unreachable endpoint. If no endpoint is reachable, explain the limit and offer Tailscale or the user's own reachable relay arrangement.
- Verify an off-LAN connection. Successful same-Wi-Fi access is not evidence of internet reachability.

OS-specific VPN approval dialogs, account login, router changes, and some macOS tunnel installation steps cannot honestly be promised as fully unattended. Automate everything safely supported and guide the remaining steps.

## 10. Login startup, updates, and uninstall

| Platform | Default implementation | Required verification |
| --- | --- | --- |
| Windows | Current-user Task Scheduler logon task, limited privileges, single-instance/restart settings | No console flash, correct PATH/tools, survives terminal close, no stored account password |
| macOS | User LaunchAgent with explicit executable and arguments | Correct user environment, login activation, terminal close, logout behavior |
| Linux | `systemd --user` unit | Correct environment, login startup and restart; separately consented linger if wanted |

For Linux without systemd, provide a documented user-session/autostart fallback and foreground-host mode. Detect unsupported automatic-service environments rather than claiming universal Linux service installation. Validate at least one non-systemd route before advertising it as automated.

Service configuration references a stable launcher and explicit agent directory, not the shell's transient npm shim or a development checkout by accident. Capture/validate needed tool paths without storing the whole shell environment or secret variables. Provide a guided environment repair for Node version managers and missing build tools. Never source arbitrary shell startup scripts under elevated privileges.

Updates and uninstall are part of the first hosting release:

- Detect active hosted work before npm replacement.
- Default to deferring updates until safe. Do not kill active tasks after an arbitrary drain timeout without explicit approval.
- Close workers and await extension shutdown only when stopping is approved; then stop the service, update, validate, and restart.
- Keep session/device storage across ordinary updates and uninstall by default. Purge is a separate confirmation.
- Reinstall/repair must replace only lunR-owned tasks, units, files, and firewall rules.
- Windows package-file locking and native PTY binaries require actual install/update testing.
- Direct external `npm install -g` cannot be fully controlled by lunR. Detect version mismatches on the next attachment and provide a safe restart instruction; do not claim uninterrupted hot upgrades.
- Disabling remote listening does not silently terminate local work. Disabling background hosting explains what must stop and offers to wait.

## 11. Delivery sequence and gates

All changes remain in the existing packages. Proposed new internal modules can live under `src/remote/`; exact file subdivision follows the repo's conventions rather than creating another package.

### Phase 0: prove terminal preservation and installation feasibility

Build an isolated experiment, not a daily-driver install. Run the real TUI under a persistent PTY worker, detach, attach at another size, and confirm a scripted long tool continues. Prove local clipboard forwarding and manual/custom dialog handoff. Test candidate PTY packaging on supported OS/CPU combinations.

Gate: no lost runtime, no degraded core TUI, no unexpected compiler prerequisite for users. Resolve TLS certificate generation and native dependency packaging before committing to the rest of the rollout.

### Phase 1: local hosted sessions

Add the host registry, worker entry, local authenticated transport, session locks, stable identity, and separate attach/detach/stop operations. Route remote-enabled local TUI launches through it. Keep standalone, print, RPC, and child launches compatible.

Touch: startup routing, `main.ts`, interactive lifecycle, session runtime/manager, new remote host/worker/local client modules.

Gate: two local terminal clients can hand off one running session without restarting its provider request or tools. Closing the first terminal does not emit session shutdown.

### Phase 2: reliable attachment and device operations

Implement controller generation, terminal negotiation/reset/repaint, bounded queues, typed side-channel commands, coherent snapshots, event sequencing, deduplication, pending interactions, image upload, and artifact retrieval. Add the terminal-control safety boundary.

Touch: TUI terminal/capability code, interactive clipboard and dialog entry points, shared session dispatch, new protocol/client modules.

Gate: disconnect during prompt submission, tool output, manual approval, plan approval, image paste, and custom component interaction. Recover coherently without duplicate task submission or unintended approval.

### Phase 3: secure remote listener and pairing

Add TLS WebSockets, identity pinning, device enrollment/revocation, VPN-interface binding, schema validation, limits, and protocol-version negotiation. Keep the network listener off until setup explicitly enables it.

Gate: unauthorized, expired, revoked, malformed, stale-controller, and incompatible-version clients cannot obtain session data or issue commands. A paired second machine can continue the exact locally started session.

### Phase 4: background ownership and recovery

Integrate cron ownership and job-store locking. Verify async subagent completion and supervisor requests while detached. Add crash/interrupted-state recovery and active-leaf checkpoints. No inference or shell effect is retried just because its outcome is unknown.

Gate: host plus multiple TUIs plus optional bot gateway do not dispatch a due job twice. A detached parent's child result arrives once. Failure recovery is honestly labelled.

### Phase 5: cross-platform setup and service lifecycle

Implement the shared wizard, Tailscale and WireGuard adapters, all three login-service adapters, environment diagnostics, and coordinated update/uninstall/repair. These can proceed in parallel after the host protocol and lifecycle contract are fixed.

Gate: fresh install, interrupted setup, sign-in startup, terminal closure, network loss, sleep/wake, update, repair, and uninstall work on actual supported platforms. Both VPN choices must pass off-LAN attachment before the feature is called complete.

### Phase 6: integration and release

Add `/remote`, remembered destinations, host/session labels, reconnect UI, and user docs. Keep default local startup fast and offline. Verify package exports/native assets, exact dependency locks, security documentation, and current tool/prompt inventories if registration or descriptions changed.

Release behind an opt-in hosting setting in the normal package. No separate preview host product and no automatic migration of a running standalone process.

### Later app work

Expose a documented client API from this same package once stable. The app can launch/manage `lunr`, embed its attached terminal, and subscribe to structured events for graphical transcript/session controls. Unsupported extension UI opens the terminal view. Do not build a second daemon or reconstruct agent state by scraping terminal text.

## 12. Focused verification

No tests were run during this planning task. The following are implementation acceptance criteria, not claims of current support.

- Same worker identity and in-flight turn across PC-to-laptop-to-PC handoff.
- Zero attached clients while a long tool and an async subagent finish.
- Lost command acknowledgment, duplicate input chunk, stale control generation, event gap, and slow receiver.
- `/new`, `/resume`, `/fork`, `/undo`, `/edit`, and `/tree` update session identity/leaf correctly across attachment.
- Approval waits across disconnect, rejects expired/stale replies, and never defaults to allow.
- Custom component/editor/tool renderer, todos, subagent spinner, footer, mouse, image fallback, and smooth-streaming behavior.
- Client clipboard image reaches host as bytes; artifact retrieval cannot escape its authorized handle.
- Host auth/config data never appears in snapshots or redacted diagnostics; revoked devices lose access immediately.
- Existing project trust remains host-enforced before loading project resources.
- Cron single ownership and child-result deduplication with host, local TUIs, and bot gateway together.
- All nine client-OS/host-OS pairings for attachment protocol; real representative Windows Terminal, macOS terminal, Linux terminal, and VS Code terminal exercises.
- Login, terminal closure, sleep/wake, VPN disappearance, native dependency loading, update, and uninstall on real Windows/macOS/Linux hosts.
- WireGuard off-LAN reachability and CGNAT failure guidance; Tailscale direct and relayed paths where available.

Use local scripted model providers for deterministic execution tests. Real VPN/service tests are separately approved manual/integration checks with isolated profiles. Do not use personal sessions or credentials as fixtures.

Extend existing focused suites where appropriate: RPC prompt semantics, interactive undo/edit and startup input, extension runner, image paste, subagent continuation/results/cancellation, cron jobs/scheduler, gateway cron, and TUI terminal/image tests. Add focused remote lifecycle/protocol/auth/setup suites rather than duplicating the full existing suite.

Build with the documented offline tui → ai → agent → coding-agent → orchestrator sequence and Node bundle. Keep first-paint/first-request checks, package install validation, touched-file Biome, and diff checks. Separate pre-existing failures from introduced ones. No installed-CLI replacement or release without explicit approval.

## 13. Work ownership for implementation

Start with one writer on Phase 0 and the shared protocol/lifecycle contract. After those settle, isolated worktrees can split into runtime/protocol, TUI/device bridge, and setup/network/service adapters. Each has exclusive ownership of its new modules. Assign a single integrator to shared `main.ts`, startup routing, interactive mode, package manifests, and docs.

Do not run multiple agents editing `interactive-mode.ts` or installer manifests in the same checkout. Use artifacts and contract tests to communicate agreed message types. Independent review is a separately requested step, not assumed by this plan.

## 14. Remaining engineering risks

- PTY/ConPTY native installation and cross-terminal renegotiation are the first gate, not details to postpone until release.
- Raw terminal input is not a transaction. A crash boundary can produce uncertainty even with duplicate suppression.
- Some custom extensions inspect the local process environment or invoke host-only GUI applications. Preserve terminal behavior but document these limits; do not claim all third-party integrations are device-transparent.
- Desktop-agent authority makes pairing and local socket permissions security-critical. This is a personal-device feature, not a multi-tenant service.
- An available VPN endpoint is necessary. No installer can remove CGNAT or guarantee access from every restrictive network.
- Graphical extension parity is not automatic. The terminal view remains the compatibility path.
- The local workspace was already dirty during investigation. Implementation should start on a dedicated branch/worktree without absorbing unrelated changes.

## Sources and investigation records

Local documentation: `packages/coding-agent/docs/{rpc,sdk,features,security,sessions,session-format,interactive-startup,tui,extensions}.md` and the source paths listed above.

Heavy investigation reports are saved under `.pi-subagents/artifacts/` with run prefix `dc329c1b-4bca-4376-9d24-1fed0caf7a5b`, covering session lifecycle, TUI reuse, and setup/networking. These are local research artifacts, not shipped runtime inputs.

Official external references:

- [node-pty and platform/build requirements](https://github.com/microsoft/node-pty)
- [ws WebSocket implementation](https://github.com/websockets/ws)
- [Tailscale installation](https://tailscale.com/kb/1017/install)
- [Tailscale relay behavior](https://tailscale.com/kb/1232/derp-servers)
- [Tailscale Personal pricing](https://tailscale.com/pricing?plan=personal)
- [Tailscale access controls](https://tailscale.com/kb/1337/acl-syntax)
- [WireGuard installation](https://www.wireguard.com/install/)
- [WireGuard endpoint/key/keepalive configuration](https://www.wireguard.com/quickstart/)
- [Windows Task Scheduler logon trigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/starting-an-executable-when-a-user-logs-on)
- [Windows task logon types](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)
- [Apple launchd agents and daemons](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [systemd service configuration](https://freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [Linux login/linger behavior](https://freedesktop.org/software/systemd/man/latest/loginctl.html)
