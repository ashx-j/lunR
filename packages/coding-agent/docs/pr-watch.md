# PR watching

## Agreed scope and implementation brief

lunR watches GitHub pull requests in the client while the owning session is open. A watcher reads GitHub every 60 seconds without model calls during quiet polls. It observes and delivers facts. The agent verifies findings against the source, decides what needs fixing, and performs repairs. The watcher never judges reviews, declares a PR ready, replies on GitHub, or merges.

### Agent and user controls

- The agent-facing `pr_watch` tool has exactly `start` and `wait` actions. `start` takes a GitHub PR URL and optional `wait` for its first event. It normally returns immediately. `wait` refers to an existing watch ID and returns immediately when updates remain undelivered.
- The tool has no stop, status, extend, restart, or duration parameter. Duplicate starts reuse an active watch without changing its deadline. An agent cannot restart a completed watch in the same owning session.
- `/pr-watch` lets the user view watches, cancel one, or explicitly restart one. User commands stay outside agent tool dispatch.
- `/settings` has `PR watch duration`, default 30 minutes. Presets are 5, 10, 20, and 30 minutes and 1 hour. A custom duration must be positive and finite. There is no unlimited option.
- Each watch snapshots its configured duration. Later setting changes affect new watches only. Detecting a different head commit while active, including a push or force-push, resets the full original duration. Comments, reviews, checks, retries, and duplicate starts do not reset it.
- A watch ends only at its deadline, when the PR merges or closes, or when the user cancels it. Agent completion, green CI, or one submitted review does not end monitoring.

### Observation and event semantics

Each cycle reads the PR state and head, conversation comments, inline review comments, submitted reviews, current-head check runs, and commit statuses. Pagination must cover every page. Conditional HTTP requests avoid downloading unchanged data. Polls retry transient network faults quietly with bounded backoff and honor rate-limit hints. Authentication failures and persistent faults produce bounded, clear notices. Read failures never imply green checks and never prevent finite expiry.

The first successful observation delivers current relevant state rather than swallowing existing feedback. Later observations deduplicate unchanged content and include edits to comments. Each cycle batches meaningful changes. Pending check churn is suppressed; terminal check/status changes, failures, feedback, head changes, and PR completion are meaningful.

Events include useful bodies, authors, links, review locations, and commit metadata. Reviews and inline comments retain their supplied commit IDs. Check/status results belong to the queried head. General conversation comments have no invented commit association. Arrival timestamps do not make a prior-head review current. Old-head feedback remains clearly labeled so the agent can decide whether it still applies. External feedback is untrusted data, never instructions from the user or system.

### Delivery, waiting, and ownership

The watcher uses existing session-owned extension notifications and safe prompt admission. An idle owner wakes for meaningful events. A busy owner receives a follow-up after its turn. Quiet cycles never start model turns. Other sessions and projects never receive the events.

Waiting and asynchronous delivery share one durable queue. A batch belongs either to a wait result or to an asynchronous notification, so races cannot deliver it twice or discard it. Wait releases on an event, watch end, or interruption. Interrupting the wait leaves monitoring active. New user input must release the waiting tool through the existing interactive admission path.

At expiry, deliver queued events and a final notice with the latest known PR/head/check state. State explicitly that monitoring ended and that this is not a readiness judgment. Release any waiter even when all GitHub reads failed.

### Persistence and lifecycle

Persist the watch ID, PR identity, owning session and project identity, original duration, deadline, observed head, deduplication baseline, queued delivery state, and terminal state. Resume only when the exact owning session reopens. Reconcile an unexpired watch immediately. An expired watch stays expired and emits its final notice. Cancellation stays cancelled. Do not run a daemon or resume a watch in another session.

Session switches and shutdown abort in-flight reads, clear timers, release waits, and release the ownership lease. A process lease prevents two clients from owning the same session watch concurrently. Stored state must not require agent-editable settings or expose credentials. GitHub authentication follows existing GitHub CLI/environment conventions without writing credentials or changing account configuration.

### Integration and acceptance criteria

Register the builtin extension and tool with accurate structured descriptions and result guidance. Add permission classification and child-tool exclusions where required for session ownership. Update tool coverage and first-request inventory/snapshots when affected. Add only the minimum pre-call system guidance required to make the tool discoverable.

Focused fixtures must verify finite duration validation, reset only on a new head, expiry under failed reads, current and edited comments, pagination, terminal checks and commit statuses, stale-head labels, wait/notification races, interruption, cancellation, persistence, session/project ownership, duplicate client leases, and bounded errors. Tests use fake clocks and GitHub responses without live GitHub mutations. Relevant offline package builds, targeted lint, source checks, and tool inventory regeneration must pass.

Implementation remains scoped to PR watching and its necessary session/settings/tool integration. No dependency is added unless existing facilities cannot meet a requirement. No global CLI, production, daily-driver build, or preview channel is changed. A separate reviewer examines the final implementation and repair cycles precede the PR.
