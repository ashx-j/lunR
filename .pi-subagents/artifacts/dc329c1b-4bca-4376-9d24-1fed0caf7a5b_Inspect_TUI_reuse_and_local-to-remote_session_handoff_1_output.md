## TUI architecture plan

**Keep the running session on one host. Move the attachment, not the process.** The PC and laptop should both use the normal `lunr` installation as clients of that host, including when the client runs on the host machine. If a session starts inside today’s local TUI process, its JSONL file can restore conversation history elsewhere, but it cannot transfer an in-flight model response, tool process, dialog, or extension instance without interruption.

For the first release, I recommend keeping the existing TUI intact inside a persistent, host-owned terminal session. A local or remote CLI attaches to it. The future app can embed that terminal for full compatibility, then add a graphical view over a structured session API. Do not make a graphical renderer a prerequisite for handoff.

### Findings that shape the design

These are implementation blockers or constraints, not a code review.

| Severity | Finding |
|---|---|
| Blocker | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:445-685,862-1015,2999-3257,3381-3710` owns the runtime, editor, commands, extension UI, permission handler, rollback, terminal, and live rendering together. Replacing its `AgentSession` reference with a network client would not preserve those behaviors. |
| Blocker | `interactive-mode.ts:4096-4192` treats quit and signal handling as runtime disposal. A lost connection or client exit must instead detach without calling `shutdown()`, emitting `session_shutdown`, aborting work, or killing tracked processes. |
| Blocker | Existing RPC is an **embedding starting point, not a remote TUI**. `packages/coding-agent/src/modes/rpc/rpc-mode.ts:122-308` ignores custom components, component widgets, header/footer/editor factories, terminal input, and several display controls. `rpc-types.ts:24-78` has no attach, live-session list, or presentation snapshot. `docs/rpc.md` confirms built-in TUI commands are absent from `get_commands`. |
| High | Extensions can provide executable component factories, custom renderers and editors, and raw-input handlers (`core/extensions/types.ts:100-230`; `docs/tui.md`; `docs/extensions.md`). These cannot be serialized as RPC data. The host-owned TUI retains them for terminal clients. A graphical client needs explicit supported UI operations and a terminal fallback for arbitrary custom components. |
| High | Terminal output depends on the attached terminal. `packages/tui/src/terminal.ts:131-220,275-435` negotiates keyboard protocols against process stdin/stdout; `packages/tui/src/terminal-image.ts:66-129` caches capabilities from process environment; `builtin-extensions/pi-subagents/src/tui/render.ts:42-43` reads `process.stdout.columns`. An attachment on another OS or emulator cannot inherit the host’s original terminal assumptions. |
| High | Clipboard images are read on the TUI machine and staged as local temp paths (`interactive-mode.ts:2879-2998`). A laptop paste must read its **own** clipboard and transfer bounded image bytes to the host. Host file paths from tools, exports, or a file picker are not laptop paths. |
| High | Permission and plan approval currently open TUI selectors through a registered handler (`interactive-mode.ts:922-938,7455-7590`). An unanswered approval must survive client detachment, be presented to the next authorized controller, and never become implicit approval. |
| Medium | The settings screen mixes host behavior with presentation (`interactive-mode.ts:4764-4865`; `docs/settings.md`). Auth, project trust, extensions, tools, model choice, rollback, and working-directory settings belong to the host. Keyboard handling, clipboard, viewport, and eventually theme and smooth-streaming presentation belong to the client. The initial host-rendered TUI may retain a shared theme until this split exists. |

### Minimum reusable client contract

Use the same host contract whether the client connects over a local transport or a remote one. It needs:

- **Discovery and attachment:** list live and saved host sessions by opaque session ID, name, host working directory, running state, and attachment state. Attach with a client ID, supported protocol version, viewport, and terminal capabilities.
- **A coherent view:** return a snapshot of persisted branch entries **and** volatile state: partial assistant message, running tool results, queues, status, extension widgets where representable, and pending interactions. Follow it with per-session, ordered events. A cursor allows replay after reconnect; if replay is unavailable, require a fresh snapshot. JSONL entry IDs alone do not cover volatile events.
- **Intent commands:** correlated, idempotent prompt, steer, follow-up, abort, model, thinking, session navigation, and host-setting actions. Separate “accepted” from “completed.” The host applies permissions and extension hooks, never the client.
- **Interactions:** identify each approval or extension dialog with a request ID, allowed response, deadline/default, and current authorized controller. Accept at most one response. Re-present pending requests on attach and reject stale or spectator responses.
- **Presentation channels:** terminal bytes and input/resize for full TUI compatibility; semantic events and actions for a later graphical view. Terminal input needs one controller lease per session. Other attached clients can observe, but must not race over focus, resize, a draft, or approvals.
- **Assets:** explicit client-to-host image upload and host-to-client artifact retrieval. Do not interpret a path string as a transferable file. Keep credentials and raw host settings out of routine snapshots.

The host must own sessions **from birth** for uninterrupted handoff. A migration of an already running, client-owned process is a separate and much harder feature, not something session-file syncing provides. If the host machine sleeps or stops, the session cannot continue elsewhere under this design.

### Change sequence

1. **Separate detach from quit.** Add a host-owned session lifecycle and a client attachment lifecycle. Keep today’s `InteractiveMode` and first-paint editor, but ensure client disconnect never invokes its runtime shutdown.
2. **Make terminal attachment durable.** Run the existing TUI on a host-owned persistent terminal, with cross-platform PTY/ConPTY support. Grant one controller input and resize ownership. On attach or controller change, reset terminal state and force a full TUI repaint rather than relying on earlier diff frames. Preserve extension factories and renderers on the host.
3. **Add the structured contract alongside terminal attachment.** Build snapshot plus ordered replay and idempotent intents around the host session. Reuse agent events and RPC command semantics where appropriate, but do not expose the current single-process RPC mode unchanged as the protocol.
4. **Move physical-device operations to the client.** Negotiate keyboard and display capabilities per attachment. Read clipboard locally, transfer image bytes, and make host artifact access explicit. Treat external editor launch as an explicit client or host choice, never silently run the host’s editor for a laptop user.
5. **Route approvals and dialogs through attachment ownership.** Keep the request alive across handoff, fail closed on timeout or loss of an eligible controller, and show it again after reconnection. Preserve extension TUI-only behavior in the terminal view.
6. **Add the app.** Have it manage the installed CLI and embed a terminal first. Add graphical transcript and controls from the structured contract, with a terminal tab for unsupported extension UI. Splitting `InteractiveMode` into a reusable graphical presenter can follow once the contract and parity tests are stable.

Keep the startup view’s early editable paint (`packages/coding-agent/src/startup/interactive-view.ts`) while local host attachment initializes. Remote availability must not turn every CLI launch into a blank screen waiting on a network connection.

### Acceptance tests worth writing

- Start a long tool or streaming response on the PC; detach its TUI; attach from the laptop; observe the **same session ID**, partial work and subsequent output, with no new model request or cancelled tool. Reattach locally.
- Disconnect while a manual permission, plan approval, or extension dialog is open. The next controller sees the same pending request. A spectator cannot answer it; two responses cannot both apply; timeout rejects.
- Exercise a custom `ctx.ui.custom()` dialog, custom tool renderer, custom editor, todo widget, and animated subagent widget through terminal handoff. Existing focused coverage includes `test/extensions-runner.test.ts`, `test/subagent-compact-row.test.ts`, and `test/subagent-escape.test.ts`.
- Paste an image from a laptop clipboard, including Windows VS Code’s `/paste-image` fallback. Verify the image reaches the host model without requiring its original laptop temp path. Use `test/image-paste-markers.test.ts` and `test/image-paste-keybinding.test.ts` as starting points.
- Attach from different terminal sizes and capabilities, including Windows Terminal, macOS Terminal, tmux, and a no-image terminal. Check repaint, keys, mouse, image fallback, and clean detach. `packages/tui/test/terminal.test.ts` and `terminal-image.test.ts` cover existing local behavior.
- Reconnect after an event gap and verify snapshot/replay has no duplicated tool cards, lost queued prompt, or false completion. Keep local first paint and first-request checks passing.

The largest risk is promising full custom-extension parity in a *graphical* view. The terminal view can retain it by running the real TUI; arbitrary extension-supplied JavaScript components cannot simply be converted into portable graphical widgets. Cross-platform PTY/ConPTY behavior and per-attachment terminal capabilities are the other substantial work items.