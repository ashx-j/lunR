## Hermes gateway review

Reference cloned shallow into the gitignored `hermes-agent/` checkout.

- Revision: `2ed6387d87b4db091af2f05db32faab6e0dbb9a2`
- Subject: `test(gateway): status readers flush the queued write before reading the file`
- Date: `2026-09-20`
- Checkout is clean. No lunR files or credentials were touched.

### What Hermes actually implements

- **Long-running gateway with resilient startup.** `gateway/run.py:5332` claims a per-home PID/runtime lock, starts a local control socket, records lifecycle state, installs shutdown handling, discovers MCPs off the event loop, then starts `GatewayRunner`. `gateway/run_startup.py:1010` creates adapters first and connects them concurrently. Failed transient platforms enter a retry queue; the gateway remains alive for cron even with no connected messaging adapter.

- **Lifecycle CLI and OS services.** `hermes_cli/subcommands/gateway.py:35` exposes `run`, `setup`, `install`, `start`, `stop`, `restart`, `status`, `list`, and profile migration. `hermes_cli/gateway.py:3407` emits a systemd unit with restart policy, planned-stop marker, watchdog support, bounded shutdown, and service self-repair. `:4279` has launchd install/start/stop/restart. `hermes_cli/gateway_windows.py:812` installs a Scheduled Task with UAC handoff or Startup-folder fallback; `:1525-1705` uses a windowless launcher, PID confirmation, planned-stop marker, bounded drain, and PID-incarnation-checked termination.

- **Phone-friendly native UX.**
  - Telegram registers command menus for default, DM, group, and forum scopes in `plugins/platforms/telegram/adapter.py:2645`, capped to avoid Telegram payload limits. It also has buttons for approvals, clarification, model selection, and slash confirmation at `:4072`.
  - Discord registers a curated native slash tree plus eligible registry/plugin commands in `plugins/platforms/discord/adapter.py:4387`; it reserves capacity below Discord's 100-command cap and provides `/skill` autocomplete with authorization checks at `:4492`. Native approval and clarification cards are at `:5481`.
  - Slack registers each declared native slash command through Socket Mode in `plugins/platforms/slack/adapter.py:1655`, dispatches it into the same gateway command path at `:5870`, and uses Block Kit approval cards at `:4804`. Slack threads cannot use slash commands, so known `!command` forms are rewritten to gateway commands at `:4424`.

- **Approvals and access control are real, not just UI.** `gateway/slash_access.py:1` gates slash commands separately from normal chat, with DM/group admin lists and a minimal non-admin floor. The runner binds approval waiters to a session in `gateway/run_turn_runner.py:1676`; `tools/approval_gateway_wait.py:130` queues, coalesces identical approvals, handles interruption, and fails closed on timeout. Native button adapters resolve the same pending approval state.

- **Sessions and projects.** `gateway/session.py:590` builds stable session keys from profile, platform, chat type, workspace, thread, and optionally participant. It persists routing/transcripts with SQLite plus fallback and validates path-derived IDs. `/new`, `/resume`, `/sessions`, and `/branch` live in `gateway/slash_commands_session.py`; `/resume` enforces origin ownership at `:246`. Multiplexing scopes config, secrets, terminal policy, memory, and sessions per profile in `gateway/run.py:1773` and starts secondary adapters with duplicate-token/listener protection in `gateway/run_adapters.py:842`.

- **Background and remote work.** `/bg` launches an isolated background session and returns its result to the source chat in `gateway/slash_commands.py:800`. Cron delivery supports origin, home, explicit targets, transcript mirroring, thread seeding, and outbound secret redaction in `cron/scheduler_delivery.py`. Restart-safe cron handoff uses a durable execution claim and atomic worker acknowledgement in `cron/scheduler.py:3370`. The API server exposes run status, SSE, stop, steer, approvals, sessions, and forks in `gateway/platforms/api_server.py:69`; approval POSTs require the owned run and exact request constraints in `api_server_runs.py:944`.

### Finding

- **Medium: relay Discord command parity is false.** `gateway/relay/command_manifest.py:45` claims to mirror the native Discord tree, but it omits `/plan`, which direct Discord registers at `plugins/platforms/discord/adapter.py:121`. Relay users therefore do not get `/plan` in the native menu. The manifest also names the `/steer` option `text` while direct Discord calls it `prompt`, a smaller UX drift. Generate both manifests from one command definition before copying this pattern.

### Worth porting to lunR

1. Keep lunR's gateway small, but add a durable runtime-status record, PID identity, control channel, planned-stop marker, and explicit service lifecycle.
2. Make Telegram/Discord first-class. Telegram gets a compact command menu and buttons. Discord gets a small native command set, dynamic autocomplete only where it matters, and strict command-cap handling.
3. Route all mobile approvals through a single session/request-id approval broker. Buttons should be transport sugar, not a second permission system.
4. Preserve session identity by platform, chat, thread, user, and lunR profile/project. Do not infer ownership from display names.
5. Deliver async child and cron outcomes back to the originating chat. Redact outbound scheduled output, and only mirror it into history when the target is known safe.
6. Treat adapter availability as capability data. Do not advertise a platform or command merely because a package is configured.

I did not run Hermes services, setup flows, dependencies, or tests. This is a source-level inspection.