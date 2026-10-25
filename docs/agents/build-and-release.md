# Build, test and release

Read before building, testing, packaging or publishing lunR.

## Build

- Offline build order: tsgo for tui, ai and agent (`npx tsgo -p <pkg>/tsconfig.build.json`), then `npm --prefix packages/coding-agent run build` (tsgo, assets and the Node bundle; bare tsgo leaves `dist/node-runtime` stale), then orchestrator. Root `npm run build` runs this offline sequence. CI does too and asserts `packages/ai` stays clean; live catalog generation is never part of PR validation.
- **Never `npm run build` in `packages/ai`** (generate-models catalog drift).
- JSON catalog: `npm run sync:model-catalog` (needs network). Do not hook generate into root `npm run build`.
- Package builds are the production typecheck; the root check does not typecheck test fixtures. Coding-agent external dependencies are exact, and the standalone installer lock preserves workspace-local resolutions such as Zod 4. The relative-import check skips vendored `builtin-extensions/` and gitignored study trees.
- Lint: `biome check packages/` (excludes `builtin-extensions/` and `*.generated.ts`).
- Pre-commit runs `scripts/check-lockfile-commit.mjs` then `npm run check` (Biome `--write` plus `check:repo`: pinned deps, relative imports, `@ts-nocheck` count, shrinkwrap, installer lock, publish-workflow policy, browser smoke), so it needs installed dependencies. CI runs `check:ci`, the same without `--write`, so unformatted code fails.
- `@ts-nocheck` count: 60 files, all in coding-agent `builtin-extensions/` (pi-subagents 39, pi-mcp-adapter 9, pi-web-access 7, pi-prompt-template-model 3, pi-intercom 2). `npm run check:ts-nocheck` fails if the count rises; lower its constant when the count drops. 83 pi-subagents files are type checked; its remaining 39 have 475 errors, mostly `subagent-executor.ts` and `subagent-runner.ts`.

## Test

- Packages: `vitest --run` (ai, agent, coding-agent), `node --test` (tui).
- `bash test.sh --workspace=packages/coding-agent -- <test files> --maxWorkers=1` runs with disposable home/profile/cache/temp directories and an allowlisted environment without credentials. Plain package `vitest --run` uses the caller's profile.
- First paint and first request: after the builds, `node scripts/check-interactive-first-paint.mjs [cli]` checks stalled and failed hydration plus first-turn subagent/MCP/LSP/fetch, and compares the full default tool payload with browser-on and browser-off baseline hashes.
- Async child questions: `node scripts/check-subagent-questions.mjs` (also `--idle`), logs under `.artifacts/`.
- CI's Script tests step installs bun 1.3.14, the version `build-binaries.yml` pins, because `scripts/build-standalone.test.mjs` bundles its probe with bun.
- Fixture gotchas live in [testing.md](testing.md).

## Run

- From this repo, `npx lunr` runs the workspace bin (`packages/coding-agent/dist/cli.js`), not the installed `@ashx-j/lunr`; rebuild first. Worktrees can share one npm bin shim, so verify a worktree with `node packages/coding-agent/dist/cli.js`. Local npx is not a published smoke test.
- `lunr update` is npm global `@ashx-j/lunr` only. Workspace `PACKAGE_NAME !== NPM_CLI_PACKAGE` skips the nag and refuses to self-update.

## Release and install

- Install: `npm i -g @ashx-j/lunr` (Node >= 22.19).
- On Windows, `node scripts/release.mjs publish-tag` fails: `run()` spawns with `shell: true` there, so the `-m "Release vX"` tag message splits into words. 0.2.33 and 0.2.34 were tagged by hand. Tag from Linux or macOS.
- Release prep checks formatting without writing; normalize inherited formatting on the release branch first. Bump with `npm run version:patch`.
- Workspace names stay `@earendil-works/pi-*`. `scripts/publish.mjs` rewrites **package.json and compiled JS/d.ts imports** to `@ashx-j/lunr{,-ai,-tui,-agent}`. Rewriting names only is not enough; `0.1.0` crashed with `Cannot find package '@earendil-works/pi-ai'`. Never publish `@earendil-works/*`.
- CI: `.github/workflows/publish-npm.yml` on `v*` tags with `secrets.NPM_TOKEN`. It builds, runs `check:ci` and the tests before publishing, then `scripts/verify-npm-release.mjs` checks every registry tarball against the integrity `publish.mjs --manifest` recorded and does a fresh isolated install. Trusted publishing needs npm-side setup by the owner first.
- A release publishes seven packages: the four public packages plus three native CuaDriver payloads. `npm run publish:dry` packs all seven; `scripts/publish.mjs` accepts both npm 10 array and npm 12 keyed `npm pack --json` output.
- npm accepts a publish minutes before the CLI metadata and tarball resolve. Treat a tag as shipped only after every registry tarball matches its integrity and a fresh isolated install reports the new version.
- Published npm docs are `packages/coding-agent/{README.md,docs/**,examples/**,CHANGELOG.md}` (packed via `package.json` `files`). Repo-root README, root `docs/` and untracked `lunr-docs/` are not what npmjs shows. `npm pack --dry-run --ignore-scripts --json --workspace=@earendil-works/pi-coding-agent` lists them. Author shipped docs for `@ashx-j/lunr` / `lunr` / `~/.lunr/`; keep ExtensionAPI `pi`, package.json `"pi"` and `PI_*` names.
- `THIRD_PARTY_NOTICES` must stay in the public files allowlist; staging copies both notices. Notice tests compare complete source bytes, not author names.
- Node bundle: CLI and SDK exports must share chunks for class identity; preserve original module URLs and external native packages. Public `./rpc-entry` resolves through `dist/rpc.js`, which prefers the bundled runtime. Publish checks verify every exported target and scan staged `dist` after specifier rewriting.
- Package size: maps, `exy.png` and catalog extras are cut (5.41 MB packed, including the 0.31 MB MCP app-bridge bundle). The 211 MB of other-platform optional packages npm installs remain; see `docs/package-size-report.md`.
