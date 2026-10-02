## Findings

Paths below are under `packages/coding-agent/`.

- **Blocker:** `src/core/session-manager.ts:826–979` has no cross-process writer ownership. Opening can rewrite migrations; independent managers retain stale trees. Gateway-only locking would not protect TUI, SDK, print, or RPC writers.
- **Blocker:** `src/gateway/agent-bridge.ts:184` builds settings, tools, and resources from daemon `process.cwd()`, even when reopening another project's session.
- **High:** `src/gateway/commands.ts:420–478` requires an existing chat session, lists only daemon cwd, and truncates discovery to ten sessions.
- **High:** `src/gateway/authz.ts` permits chat-wide, role, and pairing grants. Those are insufficient authorization for browsing the owner's entire session history. `session-keys.ts` also shares thread sessions.
- **High:** `SessionManager.branch()` and `resetLeaf()` only update memory. Reopening after `/undo` can restore a different conversation position.
- **High:** gateway ownership currently follows chat keys, not session files. Two chats can independently reopen the same file.

## Recommended architecture

Keep the existing session/runtime architecture. Add a small local ownership coordinator and durable discovery records. Do not make intercom the authority or move every TUI runtime into the daemon.

### Ownership contract

Use a canonical session-file identity plus validated header UUID. Resolve symlink and Windows path aliases before locking.

An ownership record should contain:

```text
version, sessionId, canonicalFile, generation,
ownerInstanceId, pid, processStartIdentity, hostIdentity,
ownerKind: tui|gateway|print|rpc|sdk|child,
state: starting|active|quiescing,
heartbeatAt, controllerPrincipal?
```

Acquire an exclusive per-session lock **before loading mutable state or migrating files**. Retain it until orderly shutdown finishes. Revoke the old manager's capability before releasing ownership. Check that capability before runtime actions and every manager mutation, including in-memory branch changes.

Do not reclaim merely because a heartbeat expired. A suspended process can resume and write. Automatic recovery requires verified process death; uncertain liveness fails closed. Serialize recovery/acquisition and recheck the owner identity. Existing `proper-lockfile` is available, but its time-based stale takeover alone is insufficient.

Introduce a genuinely read-only snapshot loader for listing, export, and previews. It must not migrate files. Persistent SDK/direct-manager consumers need explicit ownership release; in-memory managers remain unaffected.

### Transfer protocol

1. Resolve target and authorize the controller.
2. Reserve a transfer request containing request ID, target generation, requester, destination, and deadline.
3. Gate new work in the current runtime.
4. If busy, offer **wait until idle**, **stop then transfer**, or **cancel**. Never silently abort. Remote explicit confirmation can authorize stop when the phone user is the verified local owner; do not require an unattended TUI click.
5. Drain or explicitly cancel queued prompts and pending approvals. Wait for actual completion, including compaction, retries, shell execution, and extension shutdown.
6. Checkpoint the active leaf and effective permission mode; flush buffered session entries. Dispose subscriptions, revoke ownership, then release.
7. Destination acquires ownership and reloads the same file with fresh services built from its original cwd.
8. Commit the chat binding only after successful initialization.

The TUI becomes visibly detached and preserves its unsent draft. `/reclaim`, or an explicit reclaim button, uses the same protocol in reverse. Never resume the stale in-memory session.

If destination startup fails, leave a recoverable unowned session, report the failure, and retain the prior chat binding. Missing cwd must produce a repair choice, never silently use daemon cwd.

**Essential limitation:** block transfer while async children or other non-quiescent work remain attached. Offer waiting or verified cancellation. Migrating running children, supervisor questions, and live shell processes is deferred, not promised.

## Discovery and command semantics

Store one durable discovery record per session, separate from ownership:

```text
version, sessionId, canonicalFile, originalCwd,
originKind, lastTuiActivityAt,
manualHandoff?: { markedAt, expiresAt },
checkpoint?: { leafId: string|null, generation, fileRevision },
permissionMode?
```

- TUI `/handoff` marks the current saved session for eight hours. Repeating refreshes its timestamp. It does not silently discard work or grant broader remote access. Provide `/handoff cancel`.
- Successful transfer consumes the mark. Expiry removes only the preference, never history, files, or the active gateway binding.
- `/continue` selects a single valid manual candidate directly. With multiple candidates, show a picker ordered newest-marked first. Do not guess.
- With no valid manual candidates, select the latest TUI activity record. Define activity as session activation, accepted user prompt, or explicit state-changing user command, not background completion, token streaming, filesystem mtime, or heartbeat. Include recently closed TUI sessions, with closed/live status visible. This interpretation should be stated in command help.
- Missing or invalid candidates are pruned. Busy candidates remain candidates and require transfer handling; do not silently choose another.
- `/sessions` works before any gateway conversation exists. Use `SessionManager.listAll()` plus locally registered custom session paths. Offer project filtering, search, and pagination without a ten-session ceiling.
- Older default-location sessions remain discoverable. Arbitrary historical custom directories cannot be inferred; register them locally. Unsaved `--no-session` conversations cannot be continued without explicit conversion to persistence.

Write activity on those discrete user events. Heartbeats use a modest interval and never change activity ordering. Store leaf checkpoints on navigation and transfer boundaries, with revision validation to reject stale checkpoints.

## Access and permissions

Require explicit owner identities, scoped by platform and user ID, for cross-project discovery and continuation. Initially allow these only in private DMs. Ordinary pairing, allowed chats, role grants, and allow-all must not confer owner capability.

Bind selections and approval callbacks to owner, destination chat, session identity, generation, and expiry. Revalidate at execution, including every later message after a session becomes owner-bound.

Preserve plan/manual mode. Require explicit remote confirmation before retaining auto/yolo. Never migrate session approval grants or unresolved approval promises. Recreate permission contexts and cancel obsolete callbacks during transfer.

Project trust remains separate from owner authorization. Resolve trust and resources for the original cwd; never call process-wide `chdir()`.

## Touchpoints and implementation order

1. **Persistence protection:** `core/session-manager.ts`, new ownership/checkpoint module, `core/sdk.ts`, `core/agent-session.ts`, `core/agent-session-runtime.ts`. Include migration, fork/import, disposal, and error cleanup.
2. **Other writers:** update `interactive-mode.ts:5760` rename, `components/session-selector.ts` deletion, and `core/export-html/index.ts` snapshot reads. Print/RPC/children inherit protection centrally. Gateway cron uses in-memory sessions; TUI cron must respect quiescing.
3. **Transfer lifecycle:** add coordinator methods around `AgentSessionRuntime`; wire interactive `/handoff` and `/reclaim` through `core/slash-commands.ts` and `interactive-mode.ts`.
4. **Gateway integration:** revise `AgentBridge.defaultSessionFactory`, `switchSession`, cache eviction/reset, and `store.ts`. Enforce uniqueness by session file across chat bindings. Audit global runtime bridges for cross-project settings leakage.
5. **Discovery/security:** update `commands.ts`, `authz.ts`, `buttons.ts`, `approval.ts`, and router checks. Intercom may notify owners, but cannot grant ownership.
6. Update session/SDK/feature docs and focused tests.

Focused tests should exercise two real local processes competing for one file; paused versus dead owners; migration locking; stale callbacks; transfer rollback; original cwd/tools/context; null and branched leaf restoration; multiple marks and exact eight-hour expiry; custom paths; owner-only discovery; rename/delete contention; and blocked async-child transfer.