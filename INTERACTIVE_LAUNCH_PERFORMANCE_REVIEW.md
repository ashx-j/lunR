# Interactive launch performance review

Date: 2026-09-02
Reviewed commit: `2d2ab360723eeb6a9502b8ebb304eafad74b7fb9`

## Verdict

lunR cannot feel instant while `InteractiveMode` requires a fully hydrated `AgentSessionRuntime` before it creates the terminal editor. Small cuts will help, but they will not solve the basic problem.

The right design is a minimal interactive shell that starts the terminal, paints the editor, and captures input first. Session, model, resource, and extension initialization should run behind it. Submission waits at an explicit readiness barrier. Typing does not.

I would treat this as a product-level startup project rather than another round of scattered lazy imports.

## What the two reviewers did

Two heavy, read-only reviewers examined the same launch path independently.

- Reviewer A traced and profiled the current path, then ranked work on the critical path.
- Reviewer B designed a shell-first architecture and checked it against custom editors, extensions, permissions, project trust, resume behavior, print mode, RPC, and gateway requirements.

I checked their main claims against the current source and ran isolated offline benchmarks from the rebuilt `dist`.

## Implementation result

The follow-up branch now starts a small interactive shell before importing and hydrating the full runtime. A fresh isolated run reached these milestones:

| Milestone | Time |
| --- | ---: |
| Mode routed | 8 ms |
| Input handler armed | 127 ms |
| Raw mode active | 129 ms |
| First frame committed | 131 ms |
| Runtime hydrated | 2,530 ms |
| Prompt barrier open | 3,872 ms |

This hits the report's first target. Users can type in roughly 130 ms on the measured machine even though models, resources, and extensions continue loading. Prompt submission still waits for the complete tool and permission setup.

The branch also fixes the timing parser, records machine-readable milestones, removes the fixed benchmark delay, defers session retention, lazy-loads mode implementations, runs one cache-only model refresh during service creation, moves footer git work off the render path, and isolates deferred builtin import failures.

Remaining launch work is narrower. Settings and resource discovery still repeat some reads. Migrations still need a completion marker, auth storage still initializes eagerly, and large resource trees do not yet use an index or worker. A named deferred builtin import failure now keeps the prompt barrier closed, but the TUI does not yet offer retry or continue-without-tools controls, and a hung lifecycle handler still lacks cancellation.

## Pre-change path to an editor

```text
cli.ts
  enable compile cache
  import config, HTTP setup, timings, and all of main.ts
    import interactive, gateway, export, model, resource, and light extension graphs
  create bootstrap settings
  try install, update, package, config, and gateway dispatch
  parse arguments
  run migrations
  create startup settings
  create or open a session
  prune old sessions
  resolve project trust
  create runtime settings
  create ModelRuntime
    import providers/all
    load auth, subscriptions, models, and catalog state
    run cache-only model refresh
  reload resources
    resolve packages
    discover and load extensions, skills, prompts, themes, and context
  register extension providers
  run a second cache-only model refresh
  construct AgentSession
  initialize theme
  construct InteractiveMode
    construct ProcessTerminal, TUI, editor, footer, and containers
  InteractiveMode.init
    install input and submit handlers
    enter alternate screen
    ui.start
    apply theme settings
    bind light extensions
    render restored messages
    start deferred builtin attachment
```

`ui.start()` is the first point where the editor can receive input. Nearly the whole application has already initialized by then.

## Pre-change measurement

The original benchmark had correctness problems, so this sample is diagnostic rather than a release baseline.

Command shape:

```sh
PI_OFFLINE=1 \
PI_SKIP_VERSION_CHECK=1 \
PI_STARTUP_BENCHMARK=1 \
PI_TIMING=1 \
PI_CODING_AGENT_DIR=<temporary directory> \
node packages/coding-agent/dist/cli.js --no-session
```

One fresh isolated run reported:

| Timing lap | Time |
| --- | ---: |
| Import `main.ts` graph | 1,295 ms |
| `ModelRuntime.create` | 221 ms |
| Resource reload | 17 ms |
| Second model refresh | 10 ms |
| Tool lookup before `ui.start` | 36 ms |
| `ui.start` lap | 1 ms |
| Remaining `InteractiveMode.init` work | 483 ms |
| Deferred builtin attachment | 306 ms |
| Instrumented total | 2,411 ms |

The process took 15.5 seconds to exit because the benchmark endpoint includes deferred work, a fixed delay, terminal behavior without a PTY, and live handles that the timing total does not explain. That wall time is not a user-facing launch measurement.

The project notes record an earlier dirty-worktree prompt-ready result of 2.23 seconds plus 265 ms for deferred attachment. The new sample is in the same general range, but neither measurement records the first accepted keystroke.

## Problems found in the old benchmark

Files:

- `scripts/profile-coding-agent-node.mjs:194-221,315-366`
- `packages/coding-agent/src/core/timings.ts:38-60`
- `packages/coding-agent/src/main.ts:943-965`

Problems:

1. The parser looks for `--- Startup Timings ---`, while lunR prints `--- Startup Timings: main ---`. Parsed timing maps are empty.
2. TUI benchmark mode waits for deferred builtins, then adds a fixed 150 ms delay before exit.
3. The script calls process exit the "first usable state," even though the endpoint is much later.
4. Timing labels are sequential laps. They do not directly measure the function named by each label.
5. The harness refuses to run without an interactive terminal, which makes automated Windows and CI comparisons harder.
6. There is no milestone for input handler armed, first frame written, or prompt barrier open.

The branch repairs these measurement problems and reports the input, frame, hydration, prompt, and maintenance milestones separately.

## Findings

### 1. The TUI starts after full runtime hydration

Severity: blocker
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/main.ts:530-965`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:833-970`

`new InteractiveMode(runtime, ...)` occurs after migrations, session creation, retention, trust work, model creation, resource loading, two model refresh waves, session construction, initial input preparation, and theme initialization.

Every scan, lock, cache parse, and extension factory delays typing. Some of those inputs are unbounded because users can have large session and resource trees.

Fix direction:

Create an `InteractiveShell` that needs only enough settings for a fallback theme, cursor behavior, keybindings, and basic layout. It owns the terminal and a canonical draft buffer. Runtime hydration starts after input capture.

### 2. The launcher imports unrelated modes and every provider too early

Severity: high
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/cli.ts:20-35`
- `packages/coding-agent/src/main.ts:8-64`
- `packages/coding-agent/src/core/model-runtime.ts:32`
- `packages/ai/src/providers/all.ts:5-45`

`cli.ts` dynamically imports `main.ts`, but `main.ts` statically imports the large shared application graph before it parses the requested mode. `ModelRuntime` statically imports `providers/all`, which pulls in every provider implementation and the generated model catalog.

Even `lunr --version` pays for the shared graph before main can route it.

Fix direction:

- Add a tiny argument router at the CLI entry.
- Give interactive, print, RPC, gateway, package, config, export, and metadata commands separate dynamic entrypoints.
- Make the interactive shell its own small entrypoint.
- Replace the eager provider barrel in startup code with provider descriptors and load the chosen transport when needed.

### 3. Model initialization performs two broad cache refreshes

Severity: high
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/core/model-runtime.ts:184-235`
- `packages/coding-agent/src/core/agent-session-services.ts:137-175`

`ModelRuntime.create()` ends with `refresh({ allowNetwork: false })`. After resources load and extensions register providers, `createAgentSessionServices()` runs the same broad refresh again.

The second refresh has a correctness purpose. The problem is that both passes reload and recompose more state than the provider delta requires.

Fix direction:

Construct the runtime without refreshing. Register builtins and extension providers, then run one cache-only refresh. A later version can split catalog hydration from provider registration and only recompose changed providers.

### 4. Session retention blocks every launch

Severity: high
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/main.ts:674-699`
- `packages/coding-agent/src/core/session-retention.ts:31-87`

Every normal launch waits for session pruning before runtime and TUI construction. Cost grows with session count and filesystem latency. OneDrive and antivirus scanning make this worse on Windows.

Fix direction:

Run retention after prompt readiness. Throttle it with a timestamp, such as once per day. Keep the active-session exclusion and coordinate pruning with resume selection.

### 5. Synchronous git work can freeze the UI around first paint

Severity: high
Status: confirmed mechanism
Confidence: high

Files:

- `packages/coding-agent/src/core/footer-data-provider.ts:52-95`
- `packages/coding-agent/src/builtin-extensions/ashxj-tui.ts:725-727`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:921-950`

The footer's first uncached branch or diffstat lookup uses `spawnSync`. If this runs during initial footer binding or render, a large repository can make the visible TUI stop responding.

Fix direction:

No renderer or render-time getter should launch a process. Paint empty or cached git data, resolve branch and diffstat asynchronously, then request another paint.

### 6. Settings and resources are reread several times

Severity: medium
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/main.ts:535-536,619-742`
- `packages/coding-agent/src/core/resource-loader.ts:377-529`

Startup creates bootstrap, startup, and runtime settings managers. Resource reload reads settings again. Trust resolution can cause another pass through package and extension discovery.

Fix direction:

Load global settings once into an immutable startup snapshot. Add project settings after cwd and trust resolve. Reload only after a settings write or a trust transition that changes available project resources.

### 7. Migrations rescan legacy state on every launch

Severity: medium
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/main.ts:615-617`
- `packages/coding-agent/src/migrations.ts:96-155,227-268,326-425`

`runMigrations()` checks legacy auth, sessions, tools, keybindings, extension directories, and `.pi` state on every launch. Some paths recurse.

Fix direction:

Persist a migration schema version after successful completion. Use a cheap top-level existence check before any legacy walk. Keep only migrations that affect current session correctness before the prompt barrier. Move the rest after paint.

### 8. Authentication storage initializes and locks synchronously

Severity: medium
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/core/model-runtime.ts:184-215`
- `packages/coding-agent/src/core/auth-storage.ts:58-130,180-205`

Model creation eagerly constructs credential storage. The file backend creates storage when absent and uses synchronous lock retries. Under contention, the main thread can busy-wait for roughly 180 ms.

Fix direction:

Treat a missing auth file as an empty store without creating it. Load credentials when model selection or provider listing needs them. Use asynchronous waits for lock contention.

### 9. Deferred builtin failure can open an incomplete first turn

Severity: high
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/builtin-extensions/index.ts:43-72`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1725-1765`

Deferred modules load through one `Promise.all`. One import failure rejects the whole batch. `attachDeferredBuiltinExtensions()` catches the error and resolves. Prompt submission waits for that resolved promise, then proceeds without the missing tools. A `session_start` handler that never settles has the opposite failure and can block submission forever.

Fix direction:

Load builtins independently and return a structured result with names, successes, and failures. Keep typing available, but make prompt readiness explicit. On required failures, offer retry, wait, or continue without the named tools. Add a deadline and cancellation path for extension lifecycle handlers.

### 10. Theme work is repeated and auto detection can add delay after paint

Severity: medium
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/main.ts:909-930`
- `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts:21-55`
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:877-908`

Main initializes the theme. The interactive theme controller initializes it again, then applies settings. Auto detection can wait up to 100 ms for terminal replies after `ui.start()`.

Fix direction:

Resolve one fallback or configured theme before shell paint. Start file watching and terminal auto-detection later. Validate bundled themes at build time and load the custom-theme schema only when needed.

### 11. Resource discovery combines scanning, parsing, and extension execution

Severity: high for large configurations
Status: confirmed
Confidence: high

Files:

- `packages/coding-agent/src/core/resource-loader.ts:377-613`
- `packages/coding-agent/src/core/package-manager.ts:896-948,2156-2320`

The critical path resolves packages, scans global and project trees, reads manifests and ignore files, parses prompts and themes, walks context ancestors, and executes custom modules.

Fix direction:

Split pure discovery from extension execution. Run directory scanning, metadata reads, and hashing after shell paint. A worker can do pure filesystem discovery, but extension factories must stay on the main thread. Persist a resource index keyed by cwd, agent directory, settings, package manifests, and directory fingerprints. Validate it before opening the prompt barrier.

## Target architecture

```text
minimal CLI router
  |
  +-- version, help, package, config, export, gateway, print, or RPC entry
  |
  +-- interactive shell entry
        load minimal UI settings and builtin fallback theme
        construct terminal, editor, and canonical draft buffer
        arm input
        commit first frame
        |
        +-- hydration coordinator
              resolve session cwd and trust
              finish required migrations
              load final settings
              run in parallel:
                model and catalog hydration
                resource discovery and index validation
                deferred builtin imports
              execute custom extension factories on the main thread
              construct AgentSession
              attach extensions in deterministic order
              run session_start and resource discovery hooks
              finalize tools, permissions, and system prompt
              open prompt barrier
        |
        +-- maintenance queue
              session retention
              update checks
              fd and rg installation
              git status and watchers
              plan usage and provider counts
```

## Shell behavior

The shell needs a few hard rules:

- Keystrokes, multiline paste, and image chips go into one canonical draft model from the first frame.
- Submit while hydration is incomplete queues one visible pending submission.
- The user can keep editing a new draft while the first submission waits.
- Runtime binding is atomic. No tool call can occur before permission gates and the final tool registry exist.
- A custom extension editor receives text, image attachments, cursor position, and history from the canonical draft. If it cannot accept state, delay the swap until the draft is empty.
- Hydration errors appear inside the running TUI. They do not dump the user back to a broken terminal.
- Print, RPC, and gateway keep full pre-turn hydration because they gain nothing from an early editor shell.

## Designs to avoid

- Do not hand the terminal between two processes. Raw mode, alternate-screen ownership, terminal replies, and draft transfer make that fragile.
- Do not run the first turn before enabled tools attach. That changes the system prompt, permissions, and tool inventory.
- Do not execute extension factories in a worker. Their callbacks and TUI integration are not transferable.
- Do not cache executed extension state. Cache discovery inputs and parsed metadata only.
- Do not move the Bun `host-static.ts` path into Node. It would restore eager provider and loader imports.

## Implementation sequence

### Phase 1. Repair measurement

Add machine-readable monotonic milestones:

1. process entry
2. mode routed
3. input handler armed
4. raw mode active
5. first frame committed
6. runtime hydrated
7. prompt barrier open
8. first provider request started
9. deferred maintenance idle

Use `performance.now()` or `hrtime.bigint()`. Node's current documentation supports in-process performance marks, CPU profiles, and the module compile cache:

- [Node.js performance measurement APIs](https://nodejs.org/api/perf_hooks.html)
- [Node.js command-line and compile-cache options](https://nodejs.org/api/cli.html)

Add PTY tests on Unix and ConPTY tests on Windows. Inject input before hydration finishes and verify the final draft exactly.

### Phase 2. Split mode routing

Move argument routing into a tiny entrypoint. Add an import allowlist test so the interactive shell cannot pull gateway, export, provider transports, syntax highlighting, jiti, or deferred builtins into its first-frame graph.

### Phase 3. Extract the shell

Separate the editor, terminal, and draft model from `AgentSessionRuntime`. Start input before runtime hydration. Add the queued-submit barrier and startup error UI.

### Phase 4. Shorten hydration

- Run one model refresh.
- Reuse settings snapshots.
- Defer retention and nonessential migrations.
- Remove synchronous git from render paths.
- Import deferred builtins in parallel with model and resource discovery.
- Keep deterministic attachment order.

### Phase 5. Add persistent resource indexing

Profile first. If discovery remains material, add the validated index and worker-assisted scan. This is a bigger change and should follow the shell, not block it.

### Phase 6. Test a bundled shell

After mode splitting, compare a small bundled Node shell with normal compiled ESM. Keep native image code, jiti, custom extensions, and provider transports outside the bundle. Accept the bundle only if packaged-artifact startup improves without complicating releases.

## Provisional performance targets

These are targets, not claims about current performance:

| Milestone | Warm p50 | Cold Windows p95 |
| --- | ---: | ---: |
| Input handler armed | under 250 ms | under 900 ms |
| First frame committed | under 300 ms | under 1,000 ms |
| Prompt barrier open with a small local configuration | under 900 ms | under 2,000 ms |

The shell makes the first two targets independent of session count, catalog size, custom resources, and provider count. Prompt readiness will still vary because enabled extensions are user code.

## Regression and benchmark gates

- Run twenty warm and five cold packaged-artifact launches per supported platform.
- Record p50 and p95 for input armed, first frame, and prompt ready.
- Preserve keystrokes, paste, image chips, cursor position, and queued submit during delayed hydration.
- Simulate a hung model load, resource scan, builtin import, and `session_start` handler.
- Verify that editor input stays responsive while submit waits.
- Compare the final system prompt and tool inventory with the current implementation.
- Cover custom editors, custom flags, provider registration order, trust prompts, resume, fork, missing cwd, and first-time setup.
- Keep permission mode installed before any tool call.
- Verify print, RPC, and gateway behavior separately.
- Fail if a network call or subprocess starts before input armed.
- Track imported module count and event-loop delay as secondary metrics.

## Recommendation

Start with measurement and the shell extraction. Do not spend a week shaving ten milliseconds from settings parsing while 1,295 ms of import work and the entire runtime still sit in front of the editor.

The significant code change is justified here. It changes startup from "initialize everything, then show the UI" to "show a safe UI, then initialize everything required to submit." That is the only route to a launch that consistently feels immediate.