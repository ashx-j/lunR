## Gateway review

Gateway loads all builtin extensions before the first turn and binds them in headless print mode (`agent-bridge.ts:162-219`). Manual tool approvals are routed back to the originating chat (`router.ts:224-226`, `approval.ts:123-149`). Session records survive daemon restart through `gateway-sessions.json`.

### Confirmed findings

1. **P1: Extension-command feedback is lost on the phone.**  
   `AgentSession.prompt()` executes registered extension commands and returns without an LLM turn (`core/agent-session.ts:1274-1291`). Gateway binds the default no-op UI (`core/extensions/runner.ts:201-227`) and only returns final assistant text (`gateway/agent-bridge.ts:223-235`), while the router has no persistent event-to-chat delivery path (`gateway/router.ts:202-231`).

   This makes notify-only commands silent or return a prior assistant response. For example, every `/cron` result uses `ctx.ui.notify()` (`builtin-extensions/lunr-cron.ts:194-267`). Direct `/run`, `/chain`, and `/parallel` send custom slash-result messages, but those also never reach the platform (`pi-subagents/.../slash-commands.ts:512-564, 974-1035`).

   Worse, direct `/run` launches an async child but does not create an agent turn, so headless auto-drain never runs. Completion notification later starts an unobserved session turn, after the gateway request has already returned. The phone receives neither launch acknowledgement nor completion.

2. **P1: Gateway ignores `defaultPermissionMode`, so remote coding is always manual.**  
   Gateway creates a `SettingsManager` (`gateway/agent-bridge.ts:181-183`) but creates each permission context without its configured mode (`gateway/agent-bridge.ts:317, 541`). `createPermissionContext()` defaults to the process default, initialized as `manual` (`core/permissions.ts:119-132`). The interactive mode is the only caller that applies `getDefaultPermissionMode()`.

   There is also no gateway `/mode` or `/plan` command in `CHAT_COMMANDS` (`gateway/commands.ts:204-662`). A user who configured auto or yolo still must approve every write/bash from their phone. Plan parity would also need session-scoped plan approval handling, not just the current generic approval buttons.

3. **P1 product gap: one gateway daemon has one immutable working directory.**  
   New and reopened gateway sessions always use `process.cwd()` (`gateway/agent-bridge.ts:180, 189-197`). `/sessions` lists only `SessionManager.list(process.cwd())` (`gateway/commands.ts:416-503`), and there is no remote project selector. A daemon launched in project A cannot safely switch to project B from the phone, which prevents real away-from-home work across projects.

4. **P2: Phone and local TUI can concurrently mutate the same session file with no ownership coordination.**  
   Gateway can attach a local session through `/sessions`; each process independently opens and caches it. `SessionManager` appends without a cross-process lock (`core/session-manager.ts:946-982`) and some operations rewrite the whole file after opening it for truncation (`:910-920`). Concurrent ordinary turns can create divergent branches; a concurrent rewrite/compaction can discard entries written by the other process. The code proves no lease or reload protocol exists. I did not reproduce file loss.

5. **P2 parity issue: model-initiated async subagents are not actually asynchronous for phone users.**  
   In headless mode, the subagent extension waits for all current-session background work during `agent_end` (`pi-subagents/.../extension/index.ts:601-607`; auto-drain timeout is 30 minutes). The gateway holds the original chat request rather than acknowledging a launch and later pushing completion. This is documented behavior, but it is a poor fit for mobile control and makes timeout/reconnect behavior fragile.

### Smallest coherent path

Add a first-class `gateway` extension mode with a delivery bridge, not more router-specific commands:

- Bind a gateway UI presenter that forwards `ui.notify()` and visible custom messages to the current chat.
- Persist the session key's reply destination, then deliver later extension-created turns and subagent completion notifications even when no inbound request is active.
- Disable headless auto-drain for gateway mode. Return a launch acknowledgement, then send completion/attention notices through that delivery bridge.
- Add an allowlisted `/project` command that rebuilds services/session state for the selected cwd. Respect existing project-trust decisions rather than remotely trusting arbitrary folders.
- Initialize permission contexts from `settingsManager.getDefaultPermissionMode()` and add `/mode`; make plan approval transition that session out of plan mode.
- Add a cross-process session lease. If local TUI owns a session, gateway should refuse, fork, or open read-only.

Residual concern: gateway's first session creation fully loads extensions and runs resource loading on the inbound path (`agent-bridge.ts:203-211`, `core/agent-session-services.ts:145-168`). I could not live-test cold latency, but a missing package/network delay can leave a phone request waiting with no gateway-specific timeout or readiness status.