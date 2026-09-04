# lunR performance and bug review

Date: 2026-09-02
Reviewed commit: `2d2ab360723eeb6a9502b8ebb304eafad74b7fb9`

## What was reviewed

Four heavy, read-only reviewers split the project into these areas:

1. Model, provider, authentication, catalog, and network startup
2. Sessions, tools, permissions, rollback, subagents, gateway, cron, and orchestration
3. TUI rendering, input, streaming, terminal behavior, and interactive state
4. Builds, packaging, release automation, tests, and cross-package integration

The first reviewer lost its connection before returning findings. Two later launch reviewers covered the startup portion in more depth. Their launch findings are in [`INTERACTIVE_LAUNCH_PERFORMANCE_REVIEW.md`](INTERACTIVE_LAUNCH_PERFORMANCE_REVIEW.md).

I checked the reported mechanisms against the current source. "Confirmed" means the faulty path exists in the code and has a deterministic failure scenario. It does not mean every finding has a new automated regression test yet.

## Implementation status

The follow-up branch addresses findings 1 through 16. Focused regression tests now cover permissions, rollback, session graph validation, orchestrator shutdown and persistence, terminal sanitization, pinned chat, Unicode input, narrow viewports, footer caching, process selector updates, and release staging. Bracketed paste and default untrusted text components strip terminal controls. Trusted styled `Text` output still permits lunR's OSC 8 hyperlinks by design.

Finding 17 remains open. Manual npm publication still needs a source-tag guard.

## Priority order

I would fix these first:

1. Close the Manual mode child-process permission bypass.
2. Sanitize terminal control bytes at every untrusted text boundary.
3. Bound RPC child shutdown and Radius calls.
4. Make orchestrator state writes atomic and corruption-tolerant.
5. Separate TUI paint requests from chat-layout invalidation.
6. Repair the release build and local release rehearsal.

## Findings

### 1. Manual mode can be bypassed through one full-access child

Severity: high
Category: bug, permission bypass
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/core/permissions.ts:248-405`
- `packages/coding-agent/src/core/subagent-permission-inherit.ts:42-83`

Manual mode prompts before direct `bash`, `edit`, and `write` calls. A launch of more than two children has a separate aggregate confirmation. Omitted child permissions resolve to `full`, and a full child starts in Auto mode.

A model can therefore launch one child and ask that child to mutate files or run shell commands without the approval that Manual mode would require in the parent.

Fix direction:

- Treat every full-access child launch as a mutating action in Manual mode.
- Keep read-only children unprompted.
- Keep Plan mode's current full-child rejection.
- Show the requested child description and permission level in the approval prompt.

Focused test:

1. Set the parent to Manual.
2. Call `gateToolCall("subagent", { task: "write a file", permissions: "full" }, ...)`.
3. Assert that the call cannot proceed without an approval decision.
4. Add an integration case where an approved and a rejected child each attempt `write`.

### 2. Bracketed paste accepts raw terminal control sequences

Severity: high
Category: bug, terminal security
Status: confirmed
Confidence: high

Files:

- `packages/tui/src/components/editor.ts:1064-1170`
- `packages/tui/src/utils.ts:226-318`

The editor's `normalizeText()` changes line endings and tabs but leaves ESC, OSC, DCS, APC, C0, and C1 control bytes intact. Later rendering preserves recognized terminal sequences so lunR's own styles keep working. A pasted OSC 52 sequence can reach the terminal as control data instead of visible text. Depending on terminal policy, pasted text can alter the clipboard, change the title, or corrupt the display.

Fix direction:

Sanitize untrusted text when it enters the editor. Preserve ordinary newlines and tabs, but remove or visibly escape terminal controls before lunR adds trusted styling. Apply the same rule to model output, tool output, extension text, filenames, and process labels.

Focused test:

Paste `safe\x1b]52;c;SGVsbG8=\x07` through the bracketed-paste path and assert that rendered output contains no raw OSC introducer or BEL terminator.

### 3. RPC child disposal can wait forever

Severity: high
Category: bug, process lifecycle
Status: confirmed
Confidence: high

File: `packages/orchestrator/src/rpc-process.ts:186-196`

`dispose()` sends `SIGTERM` and then waits for `exit` with no timeout or escalation. It also installs the exit listener after sending the signal. A child that ignores `SIGTERM` blocks stop, failed-spawn cleanup, and orchestrator shutdown. A fast synchronous exit can race listener registration.

Fix direction:

- Register the exit waiter before signaling.
- Add a short grace period.
- Kill the process tree after the deadline.
- Recheck `exitCode` and `signalCode` after listener registration.
- Make disposal idempotent.

Focused test:

Use one fixture that ignores `SIGTERM` and another fake child that emits `exit` during `kill()`. Both disposal calls must settle within a fixed deadline.

### 4. Rollback can follow a replacement symlink outside allowed roots

Severity: high
Category: bug, filesystem safety
Status: confirmed mechanism, already listed in `AGENTS.md` Deferred
Confidence: high

File: `packages/coding-agent/src/core/rollback.ts:448-540`

Rollback checks the lexical path against allowed roots. It then calls `writeFileSync()` on that path. If a command replaces a snapshotted project file with a symlink or junction before rollback, the write can follow it to a target outside the project.

Fix direction:

- Reject symlinks and junctions in the target and parent chain.
- Resolve the existing parent with `realpath` immediately before restoration.
- Verify that the resolved parent remains under an allowed root.
- Use an atomic restoration method that does not follow the final path.

Focused test:

Snapshot a project file, replace it with a symlink to a file in another temporary directory, run rollback, and assert that the external file is unchanged.

### 5. Release CI and binary builds use the forbidden network-dependent AI build

Severity: high
Category: build and release bug
Status: confirmed, already documented as a CI caveat in `AGENTS.md`
Confidence: high

Files:

- `package.json:15`
- `packages/ai/package.json:50-55`
- `.github/workflows/ci.yml:35-36`
- `scripts/build-binaries.sh:108-112`
- `.github/workflows/build-binaries.yml:50-51`

The root build runs `packages/ai`'s `build` script. That script regenerates model files from live provider data before compiling. Normal CI and binary releases can fail because a provider is down or changed its response. The same path can change generated source during a release build.

The npm publication workflow already uses the correct offline `tsgo` sequence. General CI and binary builds do not.

Fix direction:

Use the same explicit offline package build order in CI and `build-binaries.sh`. Keep live model generation in the catalog refresh workflow and the explicit catalog command.

Focused test:

Run the release build with network access blocked, then assert that compilation succeeds and `git diff --exit-code -- packages/ai` remains clean.

### 6. Multiple RPC streams can receive each other's UI requests

Severity: medium
Category: bug, async routing
Status: confirmed
Confidence: high

File: `packages/orchestrator/src/supervisor.ts:95-112,197-233`

Session events use a subscriber set. UI requests use one mutable `live.onUiRequest` callback. Opening stream B replaces stream A's callback. A request caused by A can then appear in B. Closing B clears the callback instead of restoring A.

Fix direction:

Route UI requests by the stream and request ID that initiated the RPC. If the child protocol cannot express that mapping, enforce one active RPC stream per instance and reject later streams.

Focused test:

Open streams A and B, issue an RPC from A that asks for UI input, and assert that only A receives it. Close B and verify that A still receives later requests.

### 7. A truncated orchestrator state file can prevent startup

Severity: medium
Category: bug, persistence
Status: confirmed
Confidence: high

Files:

- `packages/orchestrator/src/storage.ts:1-73`
- `packages/orchestrator/src/serve.ts:14-34`

`saveInstances()` overwrites `instances.json` in place. `loadInstances()` parses it without recovery. Power loss or process termination during the write can leave truncated JSON, after which recovery fails and the server closes.

Fix direction:

Write a temporary file in the same directory, flush it, and rename it atomically. On parse failure, quarantine the corrupt file, log the path, and start with an empty list.

Focused test:

Start with a truncated `instances.json` under a temporary orchestrator directory. Recovery should preserve the bad file under a quarantine name and still start the server.

### 8. Cyclic session parent links can freeze the process

Severity: medium
Category: bug, session integrity
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/core/session-manager.ts:457-470`
- `packages/coding-agent/src/core/session-manager.ts:1189-1201`

Session loading accepts parsed entries without validating parent graph integrity. `getBranch()` follows `parentId` until no parent remains. A two-entry cycle loops forever and blocks the event loop.

Fix direction:

Track visited entry IDs during traversal and throw a clear corruption error on a repeat. Validate duplicate IDs, self-links, missing parents, and cycles when a session opens.

Focused test:

Open a two-entry cyclic JSONL session in a child process. Context construction must return a corruption error before a short timeout.

### 9. Radius calls can hold local lifecycle operations indefinitely

Severity: medium
Category: bug and performance
Status: risk with a confirmed unbounded path
Confidence: medium-high

Files:

- `packages/orchestrator/src/radius.ts:44-76,145-232`
- `packages/orchestrator/src/supervisor.ts:270-320`

Radius `fetch()` calls do not have explicit deadlines. Spawn waits for registration, stop waits for disconnect, and shutdown handles instances serially. A server that accepts a connection but never returns headers or a body can hold local process management indefinitely.

Fix direction:

Add `AbortSignal` deadlines. Dispose local RPC resources even if remote cleanup fails. Run shutdown with bounded concurrency and report incomplete remote cleanup instead of blocking local shutdown.

Focused test:

Mock `fetch` with a promise that never settles. Spawn and stop must both finish within their deadlines, and stop must still terminate the child.

### 10. Every normal paint invalidates the full pinned-chat layout

Severity: medium
Category: performance
Status: confirmed
Confidence: high

File: `packages/tui/src/tui.ts:641-781,1037-1075`

`requestRender()` always increments `contentEpoch`. The pinned-chat cache requires the same epoch, so spinner ticks, footer updates, and dock-only changes rebuild every historical chat line and hit range. Scroll-only paints use a separate path and keep the cache.

Long sessions therefore add work to every frame even when only the footer or latest animation changed.

Fix direction:

Separate a paint request from chat-content invalidation. Track a chat structure version, or cache each child and invalidate only the changed child plus the affected suffix.

Focused test:

Render 10,000 static chat children and one animated dock child. Across 100 dock-only paint requests, static child render calls should remain close to one layout pass.

### 11. The footer rescans the whole transcript on every frame

Severity: medium
Category: performance
Status: confirmed
Confidence: high

File: `packages/coding-agent/src/modes/interactive/components/footer.ts:85-113`

`FooterComponent.render()` calls `getEntries()` and sums every assistant usage record on every render. Loader ticks and streamed output make this cost grow with session length.

Fix direction:

Maintain cumulative usage when assistant entries arrive. Recompute only after rewind, session replacement, compaction, or a mutation to the final entry.

Focused test:

Render a footer backed by 20,000 assistant entries 300 times without changing the session. The entry traversal should happen once.

### 12. Astral Kitty printable keys can be inserted twice

Severity: medium
Category: bug, Unicode input
Status: confirmed mechanism
Confidence: high

File: `packages/tui/src/stdin-buffer.ts:280-404`

Kitty duplicate suppression compares the following raw sequence only when `sequence.length === 1`. An emoji occupies two UTF-16 code units. The pending code point is not matched, and the parser can emit the character again.

Fix direction:

Read one Unicode scalar with `codePointAt(0)` and advance by its code-unit length. Compare the complete scalar with `pendingKittyPrintableCodepoint`.

Focused test:

Process `\x1b[128512u😀` and assert that the buffer emits one printable character.

### 13. A one-column terminal can receive two-column TUI lines

Severity: medium
Category: bug, resize handling
Status: confirmed
Confidence: high

File: `packages/tui/src/tui.ts:699-781`

When pinned chat overflows, lunR reserves a one-column scrollbar gutter but clamps chat width to at least one. A terminal with one column gets a one-column chat line plus a one-column scrollbar.

Fix direction:

Disable the gutter below two columns, or render a zero-width chat region and only the scrollbar.

Focused test:

Set the virtual terminal width to one, render overflowing pinned chat twice, and assert that every line has visible width at most one.

### 14. Kitty image snapping can hide the newest line at scroll offset zero

Severity: medium
Category: bug, scroll correctness
Status: confirmed from layout arithmetic
Confidence: medium-high

File: `packages/tui/src/tui.ts:675-781`

If the viewport starts inside reserved image rows, `snapStartToKittyImageHeader()` moves the start backward. The fixed slice height does not change, so the slice can end before the newest line even though scroll offset is zero.

Fix direction:

Keep the viewport end fixed when following the latest output. If the image cannot fit, suppress its clipped rows or render a placeholder instead of moving the entire slice backward.

Focused test:

Create a three-row viewport whose calculated start lands in reserved image space followed by new text. Offset zero must still include the final chat line.

### 15. The process selector refreshes state without repainting

Severity: low
Category: bug, timer lifecycle
Status: confirmed
Confidence: high

File: `packages/coding-agent/src/modes/interactive/components/processes-selector.ts:18-45`

The two-second timer rebuilds the selector but does not request a render. Process status and elapsed time remain stale until unrelated input causes a paint. The component also lacks a public disposal method for removal paths other than its own close callback.

Fix direction:

Inject a paint callback, call it after refresh, and expose an idempotent `dispose()` that clears the interval.

### 16. `release:local` is broken and checks the old product

Severity: medium
Category: build and release bug
Status: confirmed
Confidence: high

Files:

- `package.json:36`
- `scripts/local-release.mjs:8-13,158-260`

The script requires the root package name `pi-monorepo`, while the current root is `lunr`. If that guard is corrected, it still expects `pi-*` archives, creates `pi` shims, and packs the private workspace package names instead of the public `@ashx-j/lunr*` output.

Fix direction:

Reuse the staging and rewrite path in `scripts/publish.mjs`. Test `lunr` shims, `lunr-*` archives, public package names, and rewritten runtime imports.

Focused command:

```sh
npm run release:local -- --skip-check --skip-test --skip-install
```

The repaired flow should then install its staged tarballs and run `lunr --version` plus a public package import.

### 17. Manual npm publication is not tied to a tag or expected source

Severity: medium
Category: release safety risk
Status: risk
Confidence: high

Files:

- `.github/workflows/publish-npm.yml:4-48`
- `scripts/publish.mjs:118-194`

The manual workflow can run from the default branch without an expected version or source SHA. The publish script checks lockstep workspace versions and registry existence, but not that `HEAD` matches `v${version}`.

Fix direction:

Require an expected version and source ref for manual dispatch. Reject publication unless the package version, selected tag, and checked-out commit agree.

## Areas checked without a new finding

- File mutation queue serialization
- Process registry entry bounds and session filtering
- Direct protection of global `AGENTS.md` and memory files
- Rollback turn retention and empty-turn behavior
- Basic orchestrator IPC framing and stale socket probing
- Differential terminal updates and synchronized output framing
- Normal alternate-screen shutdown and restore
- Mouse wheel, scrollbar drag, and Shift selection behavior
- Smooth-streaming grapheme accounting and catch-up limits
- Package-name rewrite mapping in `scripts/publish.mjs`
- Default `~/.lunr/agent` resolution
- Recent VS Code image-paste wiring

## Review limits

This was a broad static and targeted source review, not a proof that no other bugs exist. The review group did not run destructive filesystem or release tests. One of the original four reviewers failed before returning results. The later launch reviewers covered its startup remit, but they did not replace a full provider and OAuth audit.

The best next step is to turn the first six findings into red regression tests before changing implementation. That gives the larger launch work a safer base.
