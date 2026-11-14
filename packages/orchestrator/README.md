# lunR orchestrator

Internal and experimental. This package is not published to npm. Its CLI, APIs, and behavior may change or be removed without notice.

A local supervisor that starts `lunr --mode rpc` child processes and lets you list, control, and stop them over a Unix socket. When a stored Radius login or `RADIUS_API_KEY` exists, it also registers the machine and its instances with Radius, the hosted gateway service (default `https://radius.pi.dev/`).

## CLI

Build the workspace, then run the CLI from the repo root:

```bash
node packages/orchestrator/dist/cli.js --help
```

Subcommands are `serve`, `list`, `spawn`, `status`, `stop`, `rpc`, and `rpc-stream`.
