# Interactive startup

lunR paints the normal moon chatbox before loading the agent runtime. It keeps
that terminal and editor through attachment. Enter holds the editable draft until
session setup and required extension hooks finish. Escape cancels a pending
submission. Failed initialization preserves the draft and reports the error.

First paint and first request are separate measurements. An early chatbox does
not mean the agent can send a request yet.

## First-request loading

The Node build uses split ESM bundles in `dist/node-runtime`. CLI and SDK entry
points share chunks so extensions see the same SDK classes as the running CLI.
The package RPC export uses a small wrapper that prefers its bundle and falls
back to the unbundled entry after a TypeScript-only development build. The
original `dist` layout remains available for assets and native dependencies.
The build preserves original module URLs for asset lookup and extension aliases.

Startup still registers tools, commands, permissions, and session hooks before
opening the prompt barrier. It does not replace tool schemas with placeholders.
The expensive implementations load when needed:

- Web tools load providers, extraction, and browser curation separately.
- The built-in headless browser is enabled by default and can be hidden in `/settings`. Its runtime and Playwright load on first browser use. Installation, not startup, installs Chromium. See [Headless browser](../../packages/coding-agent/docs/browser.md) for recovery and network limits.
- LSP registers its tools before loading clients and Tree-sitter. Configured
  autostart runs in the background; first use waits for the required services.
  A server command that fails to spawn with `ENOENT` is not tried again in that
  session; `/lsp-restart <language>` clears it.
- MCP registers the proxy and cached direct-tool definitions without loading its
  connection engine. Configured eager servers, keep-alive, and metadata discovery
  retain their background behavior.
- Subagents keep restoration and watchers at startup, but load the executor on
  first use.
- Third-party extensions load jiti when needed. On Node, lunR imports jiti's
  default entry, which loads babel (1.5 MB, about 200 ms) only when a file misses
  jiti's disk cache; `jiti/static` loads it at once. Bun's static extension host
  keeps `jiti/static` and its embedded modules. Package-management commands and HTML export load their
  implementations only when invoked.

Session replacement invalidates pending initialization. MCP cancels initialization
and closes partially connected state. LSP drops stale write diagnostics. Web
requests and curator callbacks cannot publish into a replacement session.

After an edit or write, the LSP diagnostics hook shows only diagnostics for the
version that edit sent, and waits at most 500 ms. typescript-language-server
publishes without a version, so lunR asks tsserver through
`typescript.tsserverRequest` (4.4.0 and newer); tsserver's request queue keeps it
behind the change. Other servers count only a publish that carries the sent
version. A server that publishes without one, such as typescript-language-server
before 4.4.0, gets one "unavailable" note and no waits after that. So does a dead
tsserver. An answer that misses the wait goes out with a later tool result only
if no tool that can change files ran since (`late-diagnostics.ts`), and
`agent_end` drops it. While tsserver loads a project and on a 6,000-line file,
edits get "not ready in time". The first open of a file makes tsserver load the
project (2.4 s on a 2-file project, about 14 s on the lunR repo), and lunR opens a
file only on its first write after the server is up.

`lsp_diagnostics` on one file waits up to 15 s (`DIAGNOSTIC_TOOL_WAIT_MS`) for a
starting server, sends the file's current content and waits for an answer tied
to it. It answers "clean" only from such an answer. Otherwise it says type
checking did not run and why, with tree-sitter's syntax check; it never reads an
empty publish cache as clean. This path needs a `typescript` with
`lib/tsserver.js` in the workspace. TypeScript 7 has none, so
typescript-language-server does not start there; TypeScript 7's own
`tsc --lsp --stdio` is a language server with pull diagnostics that lunR does not
use yet.

The Node bundle enables Node's compile cache (`<agent dir>/compile-cache`) only
for non-interactive launches (`-p`, json, rpc, acp, `--help`, subcommands). On
Linux it cut a one-turn print run by about 170 ms, but it delayed the interactive
first request by about 60 ms, as it did in the 2026-09-08 Windows measurement.
Node rejects entries whose source or Node version changed, so an old cache after
an upgrade only costs a recompile. The unbundled launch path always enables it.

typebox ships prebuilt in `dist/node-runtime/typebox/` (9 entries, 9 shared chunks and
a manifest, `scripts/build-typebox-prebundle.mjs`). Installed, it is about 670 ESM files,
and loading them cost about 170 ms per launch. `cli-runtime.ts` calls
`installTypeboxPrebundle()` before anything imports typebox. Its `module.registerHooks`
resolve hook sends every import that lands in the installed `typebox` package at the
manifest's version to the prebuilt file. That covers the bundle, pi-ai, pi-agent-core and
extensions: jiti's typebox aliases come from `import.meta.resolve`, which goes through the
hook (`require.resolve` skips it on Node 22). So a process has one copy, prebuilt or
installed. `build-node-runtime.mjs` fails when cli-runtime's static imports reach typebox,
and `typebox-single-copy.test.ts` checks a print turn against the built CLI. Any resolve hook
costs about 13 µs per resolve in the process (Node's hook machinery, measured with a no-op
hook), about 27 ms for discord.js in the gateway. A design without the hook saves that.
Schemas carry non-enumerable string markers (`~kind`, `~optional`), so a schema from another
copy validates through lunR's; format registrations do not cross copies.

`--version` is answered in `cli-runtime.ts` before `main.ts` is imported.
`--help` still imports the runtime because it lists flags from every loaded
extension, including user and project extensions.

## Validation

Run the offline build, including coding-agent's bundle step, then:

```sh
node scripts/check-interactive-first-paint.mjs
node scripts/profile-coding-agent-node.mjs --mode tui --skip-build --runs 10
```

The check stalls or fails runtime loading and verifies the real frame, editable
draft, and terminal cleanup. It also blocks optional implementation imports and
checks a complete first request against the baseline tool-payload hash. Separate
first-turn fixtures exercise subagent status, MCP status, Tree-sitter parsing,
and local HTTP extraction. Disabled and enabled headless-browser fixtures verify conditional tool registration while browser runtime imports are stalled. The default CI run checks the workspace build on
Ubuntu. Passing a CLI path runs the same checks against a relocated installation,
but CI does not currently pack that installation or run this check on Windows.

The publish script validates every staged compiled file after rewriting package
names and refuses missing package entry points or leftover `@earendil-works/*`
references.

The profiler uses a local Faux provider, not a remote model. It records dispatch
through the normal prompt path, plus first response and optional tool completion.
It isolates the home directory, settings, temporary files, and workspace by
default. It reports tool names and a schema hash, not prompt contents.

Use `--cli /path/to/dist/cli.js` to compare another built version. Use a dedicated
`--agent-dir` with `--warmup 1` for repeated launches. Without `--agent-dir`, each
run gets a fresh profile, including warmup runs. These are fresh profile and
compile-cache measurements, not reboot-cold filesystem measurements.

## Measured results

Windows, Node 24.15.0, offline, empty workspace, builtin extensions, 2026-09-08.
Baseline is `b709d12` with benchmark instrumentation only. Measurements preceded
the rebase onto v0.2.16; build and first-turn checks were repeated afterward.
Ten launches per cell
alternated baseline and changed builds. Repeated launches reused each variant's
own profile after one warmup. The last repeated baseline sample ran separately
after the comparison runner reached its time limit.

| Profile | Baseline request median / p95 | Changed request median / p95 | Median reduction |
| --- | --- | --- | --- |
| Fresh | 1988.8 / 2026.4 ms | 968.2 / 1007.0 ms | 51.3% |
| Repeated | 2597.6 / 2628.6 ms | 970.6 / 993.5 ms | 62.6% |

First-frame medians were 100.7 to 90.0 ms for fresh profiles and 107.2 to 90.8 ms
for repeated launches. With ten samples, nearest-rank p95 is the maximum.

First-use fixtures on Node 24 added 68 ms for subagent status, 3075 ms for MCP
status, 143 ms for LSP parsing, and 257 ms for local HTTP extraction after request
dispatch. These are single observations of complete tool execution, not isolated
import costs. Later checks measured 126 to 482 ms for MCP status, so the first-use
observations are not a stable latency bound.

The packaged CLI passed the same checks on Node 22.19.0. A separately instrumented
Node 22 run took 6 seconds to dispatch, so these medians are not a latency bound.
Remote provider latency, terminal compositor latency, reboot-cold storage, large
user configurations, and third-party asynchronous extension hooks were not
measured. Bun 1.4.2 source launch completed a local request. Standalone compilation
was blocked on both baseline and changed builds by the missing native canvas
binary in the isolated, ignore-scripts dependency installation.
