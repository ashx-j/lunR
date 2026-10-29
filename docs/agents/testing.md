# Test fixtures and known flakes

Read before writing or debugging tests. Commands are in [build-and-release.md](build-and-release.md).

- First-request fixtures strip inherited `PI_SUBAGENT_*`, `PI_SUBAGENTS_*` and `PI_INTERCOM_*` variables; inside a child the supervisor schema replaces intercom and the hash no longer measures the parent payload. Refresh both browser hashes after any agent-facing schema change. Capture inventories through the real CLI composition, not direct SDK tool descriptions.
- To refresh the Windows/macOS first-request hashes from Linux, run the startup benchmark (`PI_STARTUP_BENCHMARK=1`) with an `--import` preload that returns `win32` for `process.platform` only when the stack includes `lunr-computer-use`. Check that it reproduces master's pinned hashes before trusting new ones.
- To measure errors in `@ts-nocheck` files, rewrite each `// @ts-nocheck` line (line 2 after a shebang) to `// @ts-nocheck-OFF`, run `tsgo --noEmit`, group errors by file, then restore. The directive only hides that file's diagnostics, so one run counts every file.
- Resource-loader extension fixtures need current package builds because jiti resolves compiled aliases. Source CLI fixtures load tsx; a source-test pass does not qualify the compiled CLI. Keep legacy migration inputs and credential sentinels under `.pi`.
- Rollback fixtures keep their failure-injection tests and one disposable-home strategy. Memory restoration follows `dirname(getAgentDir())/simple-memory`.
- Offline real-binary Claude Code checks need a disposable `HOME` with fake `.claude/.credentials.json`, a loopback upstream, and `HTTPS_PROXY` at a dead port with `NO_PROXY=127.0.0.1`. Login test fakes must answer `--version` with `CLAUDE_CODE_VERSION`.
- Computer install/staging tests use inert payloads with test-only checksums; they validate packaging, not runtime acceptance.
- Intercom fixtures must stop their broker before removing its profile.
