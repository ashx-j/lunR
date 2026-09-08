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
The original `dist` layout remains available for assets and native dependencies.
The build preserves original module URLs for asset lookup and extension aliases.

Startup still registers tools, commands, permissions, and session hooks before
opening the prompt barrier. It does not replace tool schemas with placeholders.
The expensive implementations load when needed:

- Web tools load providers, extraction, and browser curation separately.
- LSP registers its tools before loading clients and Tree-sitter. Configured
  autostart runs in the background; first use waits for the required services.
- MCP registers the proxy and cached direct-tool definitions without loading its
  connection engine. Configured eager servers, keep-alive, and metadata discovery
  retain their background behavior.
- Subagents keep restoration and watchers at startup, but load the executor on
  first use.
- Third-party extensions load jiti when needed. Bun's static extension host keeps
  its embedded modules. Package-management commands and HTML export load their
  implementations only when invoked.

Session replacement invalidates pending initialization. MCP cancels initialization
and closes partially connected state. LSP drops stale write diagnostics. Web
requests and curator callbacks cannot publish into a replacement session.

The Node bundle does not automatically enable Node's compile cache. Reusing that
cache was slower in the measured bundle. Node's explicit compile-cache environment
settings remain available; the unbundled launch path keeps its existing policy.

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
and local HTTP extraction. An optional CLI path checks a relocated installation
made from the same build.

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
Baseline is `b709d12` with benchmark instrumentation only. Ten launches per cell
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
import costs. MCP's first-use delay remains visible rather than moving behind a
readiness label.

The packaged CLI passed the same checks on Node 22.19.0. A separately instrumented
Node 22 run took 6 seconds to dispatch, so these medians are not a latency bound.
Remote provider latency, terminal compositor latency, reboot-cold storage, large
user configurations, and third-party asynchronous extension hooks were not
measured. Bun 1.4.2 source launch completed a local request. Standalone compilation
was blocked on both baseline and changed builds by the missing native canvas
binary in the isolated, ignore-scripts dependency installation.
