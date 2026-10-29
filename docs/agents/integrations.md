# Gateway, ACP, PR watch and computer use

Read before changing the Discord/Telegram gateway, ACP mode, PR watch or native computer use.

## Gateway

- Paired and allowlisted users share one authorization. `ConversationBinding.owner` identifies the requester, not a tier; keep requester and fresh access checks on delayed approvals and deliveries. Legacy `owners` entries are ordinary grants. Busy-session `/stop` `/new` bypass the session guard; Telegram length = `string.length` (UTF-16). Telegram sends plain text (no `parse_mode`). Discord native commands in guild text use chat type `group`, like messages. Plan approval restores the pre-plan mode through `AgentSession.setPermissionMode` (saved); an unanswered plan prompt rejects with `PLAN_APPROVAL_TIMEOUT_REASON` so the model waits instead of revising.
- Outbox: result entries keep their source across `/new`; prompts/notices use an epoch. Failed batches stay on disk with `failed: true`, newest 20 only, and a permanent failure sends one notice. Approval details longer than `maxMessageLength` go through the outbox before the buttons message. A crash between send and on-disk ack can duplicate the last chunk.

## ACP

- Setup, limits and T3 settings: `packages/coding-agent/docs/acp.md`.
- No-approval tools are core `READ_ONLY_TOOLS`, which includes `todo`; add side-effect-free tools there. Tool calls are announced at start and end only. Modes may change mid-turn; model and reasoning changes are idle-only and stay session-local. `clientScopedModelsOnly` narrows RPC `get_available_models`; workers read it at startup.
- ACP cannot retract a form or approval; an expired request keeps its turn open until the host dismisses it. Startup dialogs return cancellation defaults. ACP sessions disable delegation guidance, browser, cron, goals and scheduled subagents (jobs can outlive a client turn) but keep MCP and explicit native children; child delegation strips temporary host MCP credentials. Child notices use content-based activity IDs.
- T3 caches each ACP agent's model list until provider refresh or restart; logging out of lunR providers does not shrink it until then.

## PR watch

- See `packages/coding-agent/docs/pr-watch.md`. Watches run only in the owning session; deadlines keep running while closed, expiry wins before any read, and only a newly observed head resets the window. Admission uses promise-returning `ctx.sendMessage`; failed admission retries on the watch timer.
- Reservations consume events only after a persisted notification or tool-result receipt. A same-turn wait removes only its own queued custom message (matched by type and details object) and transfers the reservation. Conditional 304 responses can change pagination Link metadata.

## Computer use

- Read `packages/coding-agent/docs/computer-use.md` before changing capture/input, history retention, native ownership or distribution. `scripts/computer-use-release.json` owns the pin; regenerate `release.generated.ts` after changing it. CuaDriver 0.28.1 is production-approved; a new runtime needs owner approval and a new CLI version.
- Computer results carry `details.computer` and use the scoped `tool_result` hook for the error flag; a thrown text error discards recovery images. Dispatch tracking is per call; a rejected token says nothing about earlier input. Image-only means no accessibility tree in observations; map image coordinates through crop/resize exactly once.
- Windows CuaDriver 0.28.1: XAML `hotkey` ignores `delivery_mode`, so foreground modifier shortcuts without x/y go through `press_key` with modifiers. `move_cursor` moves the real pointer only in desktop scope. Discovery queries match only `name`, `app_name` and `title` and never select a target.
