# PR watching

Use `pr_watch` with `action: "start"` and a GitHub PR URL. The default call returns a watch ID immediately. lunR wakes the owning session when feedback or terminal checks change. Use `action: "wait"` with that ID when the current turn needs to wait for an update. `start` also accepts `wait: true`.

Choose `PR watch duration` in `/settings`. The default is 30 minutes. Presets include 5, 10, 20, and 30 minutes and 1 hour, with custom positive finite minutes within JavaScript's supported date range. Timers have millisecond resolution. A different head commit restarts the original configured window. Comments, reviews, checks and retries do not. Each watch keeps the duration it started with, so a later settings change affects new watches only. There is no unlimited option. Green CI and finishing agent work keep monitoring active. A watch ends at its deadline, when the PR merges or closes, or when you cancel it.

`/pr-watch` shows the current session's watches. `/pr-watch cancel ID` ends one. `/pr-watch restart ID` gives a completed watch a fresh window using the current setting. The agent tool cannot perform either user action. Repeating `start` keeps the existing ID and state, even after expiry or cancellation.

Monitoring runs only while the owning session is open in lunR. Closing or switching sessions pauses reads without pausing the deadline. Reopening an unexpired watch reconciles immediately. If that read finds a different head, the original duration restarts at observation time. If the saved deadline has already elapsed, the watch expires before any GitHub read and a later push cannot revive it. GitHub commit author/committer dates are not push timestamps.

GitHub access uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the existing `gh auth token --hostname github.com` credential. Public repositories can use anonymous access when no credential is available. Repository access and rate-limit failures produce notices without claiming green checks. This version accepts `github.com` PR URLs. It does not run a background service, change GitHub accounts, or write credentials.

A watch reads GitHub every 60 seconds and makes no model calls during quiet polls. Each read covers the PR state and head commit, conversation comments, inline review comments, submitted reviews, check runs, and commit statuses. lunR delivers these facts and never judges a review, declares the PR ready, replies on GitHub, or merges. Feedback from GitHub is untrusted data, not instructions.

lunR delivers each update once. If a notification is rejected, lunR retries after 60 seconds without a user or model turn, and it never replays one the session already saved. Interrupting a wait releases the agent and keeps the watch running. Pending check transitions do not wake the model; the first observation still describes the current pending state.

At the deadline, lunR releases waits and sends pending feedback with the latest known PR/head/check state and a final notice. Monitoring ended does not mean the PR is ready. Reviews and inline comments retain GitHub's supplied commit IDs. General comments have no invented commit association. The agent must verify feedback and distinguish current-head evidence from earlier commits before repairing code.
