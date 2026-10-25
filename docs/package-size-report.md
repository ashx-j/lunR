# Package size report: @ashx-j/lunr

Measured 2026-10-20 on master `eee4fdba` (v0.2.38) after fresh tui, ai, agent and coding-agent builds. Sizes are in MB (10^6 bytes). This file sits outside `packages/`, so npm never ships it.

## Applied cuts (2026-10-21)

The coding-agent `files` list now drops the changes marked safe below: `!dist/**/*.map` (both kinds), `!docs/images/exy.png`, and `!dist/catalog/providers`, `!dist/catalog/providers.json`, `!dist/catalog/publication.json`. `npm run publish:dry` now packs `@ashx-j/lunr@0.2.39` at 5.41 MB packed, 21.94 MB unpacked and 1590 files. That is close to the 5.30 MB estimate; the difference is mostly the new 0.31 MB MCP Apps `app-bridge.bundle.js`. An isolated install of the packed tarballs runs `lunr --version`, `--help` (also under `--enable-source-maps`) and RPC mode. The risky and unsafe rows are unchanged.

The tables below describe the package before the cuts.

## Current size

| | Packed | Unpacked | Files |
|---|---|---|---|
| `npm pack --dry-run` of `packages/coding-agent` | 10.96 MB | 44.98 MB | 2779 |
| Registry `@ashx-j/lunr@0.2.38` | | 44.97 MB | 2781 |

Unpacked, by type:

| Part | Unpacked |
|---|---|
| `dist/node-runtime` (esbuild bundle, 208 chunks, no maps) | 9.63 MB |
| Loose `dist/**/*.js.map` (586 files, `inlineSources` so each holds the full TS source) | 13.26 MB |
| Loose `dist/**/*.d.ts.map` (586 files) | 8.13 MB |
| Loose `dist/**/*.js` outside the bundle (589 files) | 7.0 MB |
| Loose `dist/**/*.d.ts` (586 files) | 1.2 MB |
| `docs` (2.29 MB of it is `docs/images`) | 2.83 MB |
| `dist/catalog` | 1.18 MB |
| `examples` | 0.98 MB |
| `CHANGELOG.md`, shrinkwrap, install-lock, other assets | about 0.8 MB |

A global install is much larger than the tarball. `npm i -g @ashx-j/lunr@0.2.38 --ignore-scripts` (npm 11.19.1, Linux x64) writes 561 MB and 33,324 files. 211 MB of that is other platforms' optional packages: `recheck-macos-arm64`, `recheck-macos-x64`, `recheck-windows-x64` and the `lunr-computer-darwin-arm64`, `lunr-computer-win32-arm64` and `lunr-computer-win32-x64` payloads. Their `os`/`cpu` fields are correct in the published `npm-shrinkwrap.json`, but npm installs them anyway. I did not investigate the cause. Fixing it would save more than any `files` change below.

## What the entry points load

I ran each case with `strace -f -e trace=%file,execve` against the installed 0.2.38 package (no `src/` next to `dist/`), with a disposable `HOME` and `PI_CODING_AGENT_DIR` and `PI_OFFLINE=1`. Counts are package files opened, excluding `node_modules`.

| Run | Bundle chunks | Loose files opened |
|---|---|---|
| `lunr --help` | 111 of 208 | `dist/cli.js`, `dist/catalog/models.json` |
| `dist/rpc.js` with `get_state` and `get_commands` | 111 | `dist/rpc.js`, `models.json`, `modes/interactive/theme/moon.json`, the skill-creator `SKILL.md`, and 4 pi-intercom broker files |
| Interactive start in a pty, 15 s | 120 | `dist/cli.js` plus the same assets and broker files as RPC |
| SDK `import("@ashx-j/lunr")` | 84 | none |
| RPC with a user extension importing `@ashx-j/lunr` through jiti | 111 | none beyond the RPC list |

The pi-intercom broker files are `broker/broker.js`, `broker/framing.js`, `broker/paths.js` and `config.js`. The parent spawns `broker.js` as its own `node` process.

So `cli.js` and `rpc.js` load only the bundle, plus data assets. The SDK `exports` entry and the jiti alias for `@earendil-works/pi-coding-agent` and `@ashx-j/lunr` both point at `dist/node-runtime/index.js`. The `exports` map exposes only `.` and `./rpc-entry`, so Node rejects deep imports into the loose files.

## What else loads loose files

The bundle build rewrites `import.meta.url` to each module's original `dist/` path. Any code that builds a path from it therefore points into the loose layout. These cases need loose `.js` at runtime:

- `pi-intercom/broker/spawn.ts` spawns `broker.js` with node (traced above).
- `pi-subagents/.../async-execution.ts` spawns `subagent-runner.js` for background subagents.
- `pi-subagents/.../pi-args.ts` passes `subagent-prompt-runtime.js` and `extension/fanout-child.js` to child lunR processes as `--extension`. jiti loads them there.
- `pi-lsp-extension/src/lsp-manager.ts` spawns the shared LSP daemon `lsp-daemon.js` with node (before 2026-10-21 it pointed at `lsp-daemon.ts` and a missing `lsp-daemon-launcher.cjs`).
- `gateway/service.ts` writes `dist/cli.js` into the service unit. `modes/acp/process.ts` spawns `dist/cli.js` for workers.

The static import closure of those five child entry points is 162 loose `.js` files (2.1 MB). It reaches into loose `core/`, `utils/`, `gateway/` and `modes/` modules, not just `builtin-extensions/`. Apart from `cli.js`, `rpc.js` and the export-html templates, the other loose `.js` files (4.54 MB) only serve as the fallback that `cli.js` and `rpc.js` use when `dist/node-runtime` is missing.

These data assets are read at runtime: `dist/catalog/models.json`, theme JSON, `core/export-html/*` (including its `.js` templates), skill-creator `SKILL.md`, `docs/` and `examples/` (the system prompt gives the model both paths, and doctor and auth guidance print doc paths), `README.md`, and `scripts/install-browser.mjs`.

## Candidates for the `files` list

Each saving is a separate `npm pack --dry-run --ignore-scripts --json --workspace=@earendil-works/pi-coding-agent` run, with a temporary `files` edit that was then reverted.

| Change | Packed saving | Unpacked saving | Verdict |
|---|---|---|---|
| `!dist/**/*.map` (both kinds) | 4.11 MB | 21.39 MB | Safe. Nothing opens them, and the bundle has no maps. |
| `!dist/**/*.js.map` only | 2.20 MB | 13.26 MB | Safe. They only map loose files, which run in child processes or the dev fallback. You lose TS line numbers for those processes under `--enable-source-maps`. |
| `!dist/**/*.d.ts.map` only | 1.27 MB | 8.13 MB | Safe. Their targets are `../src/*.ts`, which is not shipped. |
| `!docs/images/exy.png` | 1.51 MB | 1.51 MB | Safe. No doc, README or code references it. |
| `!dist/catalog/providers`, `providers.json`, `publication.json` | 0.04 MB | 0.59 MB | Safe. Only `models.json` is read locally. The other catalog files come from GitHub. |
| `!dist/bun` | 0 | 0.01 MB | Safe, but not worth an entry. It is only used by the Bun binary build. |
| Other `docs/images` | 0.64 MB | 0.78 MB | Risky. Local doc viewers lose the screenshots. npmjs renders README images through the repository URL. |
| `!dist/builtin-extensions/**/*.d.ts` | 0.14 MB | 0.51 MB | Risky. `modes/acp/worker-config.d.ts` and `startup/interactive-view.d.ts` import builtin-extension types, so SDK types could break. |
| Drop `examples` | 0.34 MB | 0.98 MB | Risky. The system prompt points the model at it. Removing it means changing the prompt too. |
| Loose `.js` cut to the bundle, `cli.js`, `rpc.js`, export-html and the 162-file child closure | 0.97 MB | 4.54 MB | Risky. The closure is computed statically, so the build would need to generate and check it on every change. A missed file breaks subagents or intercom only when they run. |
| Drop `CHANGELOG.md` | 0.14 MB | 0.49 MB | Risky. Nothing reads it at runtime, but it is the only release history inside an install, and AGENTS.md lists it as a published doc. |
| All loose `.js` | | about 7 MB | Not safe. It breaks the intercom broker, background subagents, child extensions and the dist-path fallbacks. |
| Any `.d.ts` reachable from `dist/index.d.ts` | | | Not safe. `types` points there. |
| `npm-shrinkwrap.json`, `install-lock`, `scripts/install-browser.mjs`, `dist/catalog/models.json` | | | Not safe. Install, postinstall or startup need them. `README.md` is always packed regardless of `files`. |

The safe changes together (both map kinds, `exy.png` and the catalog extras) bring the tarball to 5.30 MB packed (down 5.66 MB, 52%) and 21.48 MB unpacked (down 23.50 MB), with 1565 files. Adding the risky loose-JS cut gives 4.34 MB packed and 17.02 MB unpacked.

## Side findings (fixed 2026-10-21)

- The shared LSP daemon could not start from an install: `lsp-daemon-launcher.cjs` did not exist. `lsp-manager.ts` now runs the compiled `lsp-daemon.js` directly.
- `pi-mcp-adapter/ui-server.ts` served a missing `app-bridge.bundle.js`. `scripts/build-node-runtime.mjs` now builds it into `dist/builtin-extensions/pi-mcp-adapter/`, and the server resolves it from `import.meta.url`.

## How to reproduce

- Build, then run `npm pack --dry-run --ignore-scripts --json --workspace=@earendil-works/pi-coding-agent` from the repo root.
- For traces, install the release with `npm i -g --prefix <tmp> @ashx-j/lunr@<version> --ignore-scripts`. Then run `strace -f -qq -e trace=%file,execve -o out node <prefix>/lib/node_modules/@ashx-j/lunr/dist/cli.js --help` with `HOME`, `PI_CODING_AGENT_DIR` and `PI_OFFLINE=1` set to a temp profile. From the workspace checkout, `getThemesDir()` prefers `src/` and the traces differ.
- For the child closure, run esbuild with `bundle: true`, `packages: "external"`, `metafile: true` and an empty `tsconfigRaw` on the five child entry points. Keep inputs under `dist/`.
