# Native computer use

This branch is a development implementation, not a supported release. Windows
MCP metadata interoperability and local runtime/lifecycle tests pass. The macOS
launch path is implemented but has not run on macOS hardware. Neither platform
has passed live desktop acceptance. Production publication remains blocked.

## Local setup

Run `/computer setup` in the local lunR terminal. It verifies and installs the
bundled runtime without downloading code, capturing the screen, or operating an
application. Setup is user-invoked and unavailable from gateway or headless
sessions.

On Windows, keep the desktop logged in and unlocked. On macOS, setup prints the
exact installed `CuaDriver.app` path. Add that app under System Settings > Privacy
& Security to both Accessibility and Screen & System Audio Recording, named
Screen Recording on older macOS versions. Enable both grants, then restart lunR.
These OS grants require the user; Auto mode cannot supply them. Setup never
selects or changes an existing `/Applications/CuaDriver.app` installation.

Complete setup before assigning GUI tasks through cron or the gateway. A setup
success verifies the runtime files, not permission grants or desktop behavior.

## Tools and permissions

Computer use and Allow foreground control default to on. Windows x64/arm64 and
Apple Silicon macOS expose `computer_load` before the first model request.
The runtime loads only when a desktop operation needs it. Linux and Intel macOS
have no default discovery tool.

Loading activates app/window discovery, accessibility and image observation,
single/right/double clicks, complete drags, scrolling, keys and modifier
shortcuts, Unicode text, app launch, window management, and workflow release.
Use these tools on the computer running lunR. Gateway sessions control the
gateway host, not the Telegram or Discord client's machine.

Prefer accessibility and background window input. Request window foreground
input only after a background failure and a fresh observation. Primary-desktop
input has no background route and requires `desktop=true` and `foreground=true`.
Foreground off blocks desktop input, explicit foreground window input, app
launches, and every window-management operation. Background delivery cannot
prevent an application from changing its own focus.

`computer_window` requires an exact window target and has no per-call foreground
or desktop option. It moves/resizes with `action=frame`, or activates the exact
window with `action=focus`. Minimize/restore invokes the supplied, freshly
observed accessibility window-control element. The pinned driver has no portable
minimize/restore RPC. If the control or minimized window cannot be observed, use
freshly observed desktop controls rather than guessing a shortcut or window id.
Text and keys can target an accessibility element, window-image coordinates,
or the observed focused field. Desktop keyboard input targets the observed
focused field; changing focus needs a separate grounded click.

Manual asks before every computer call, including observation. Plan permits
relevant observation and workflow release but blocks mutation. Auto needs no
lunR per-call prompt for requested, implied, or necessary GUI work. In Yolo,
ask first when an otherwise non-GUI task newly requires GUI. This intent rule
is agent guidance, not a natural-language authorization classifier.

Native tools are excluded from children and also refuse child execution.
Shell-capable children are not OS-sandboxed. No generic MCP registration or
raw driver policy, update, recording, or administrative tool is exposed.

## Grounding and outcomes

Each observation invalidates the previous token before contacting the driver.
A token identifies one exact window or the primary desktop, expires after thirty
seconds, and permits one action. Accessibility input includes the driver's
snapshot id. Structured refusals count as refusals even without MCP `isError`.
Partial and unverifiable outcomes remain visible; transport success is not
proof of an application change.

Window PNGs are capped by the driver at 1024 pixels on their long edge.
Window coordinates use that returned image, without another resize. Both pinned
platform implementations retain the capture resize ratio for later pixel input.
The adapter checks PNG dimensions and refuses inconsistent pixel grounding. Desktop
images are resized to at most 1024 pixels locally. Their token records separate
x/y ratios back to the driver's native desktop image. Coordinates outside the
returned image are rejected. Pixel and desktop operations require an
image-capable current model; accessibility-only observation remains available.

Observe after every action. A timeout or cancelled call may already have
changed the application. Never retry input blindly. Cancelling the MCP request
does not retract input already delivered to the OS. Normal shutdown asks the
owned runtime to drain and exit; forced process termination cannot prove that
all held input was released. Live gesture cancellation remains an acceptance
gate.

## Ownership and lifecycle

An OS-account lease holds the desktop across observe/action calls. Competing
workflows get busy rather than queueing; calls within one workflow serialize.
The lease uses the OS account home, not the selected lunR settings profile.
A short cross-process installation/acquisition lock protects changes to its
owner record. A live owner is never displaced because its heartbeat is late.
After MCP initialization and before any driver tool call, the adapter records
the runtime PIDs in that lease. Failure to record ownership blocks tool dispatch.
A crash during initialization can leave an unrecorded, idle runtime, but it has
received no desktop action. Recovery requires both the owner and its recorded
runtimes to have exited.
PID reuse can conservatively leave the desktop busy rather than kill another
process. A malformed owner record also fails closed.

`computer_end`, cancellation, agent end, settings changes, and session shutdown
close the owned runtime before releasing its lease. Queued operations cannot
survive cancellation. Settings disable removes active tools immediately;
session replacement discards loaded tools and grounding. The first-request
hook also reapplies the loaded roster after extension registration refreshes it.
If shutdown cannot be confirmed, the lease stays held. Confirm that the owned
runtime has stopped before restarting the owning lunR process.

Fresh gateway cron sessions get explicit permission contexts from the configured
default mode. They inherit neither gateway approvals nor its interactive
approval handler. Missing approval reports blocked. Session shutdown runs before
context disposal, including partial extension-bind failure. TUI cron continues
to use its live session mode.

## Runtime and packaging

The development pin is [CuaDriver 0.28.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1),
source `d8028a7943087ee258dc1b4d19dc12a7cd27669c`. This exact prerelease and its
three archive hashes are approved for branch development only.
`scripts/computer-use-release.json` is the authoritative archive inventory.
The upstream MIT license is included under `native/computer-use`.

The runtime never downloads an executable. It resolves the host's optional
payload package, or the matching archive beside a standalone binary. It verifies that archive,
extracts a fresh reference tree, and checks every cached file and helper against
that tree before execution. Redirected install paths and escaping symlinks are
rejected. Concurrent installers do not overwrite each other. A modified or
older cache is refused rather than overwritten. After confirming no runtime is
active, remove the inactive lunR runtime directory to reinstall it.

Windows uses the system `tar.exe`, not a `PATH`-selected extractor, and launches
`mcp --direct --embedded --no-overlay`. A bounded, hidden system PowerShell
helper checks WTS session activity and the input desktop name before admission.
It refuses session zero, disconnected sessions, and a non-Default or inaccessible
input desktop. It reads metadata only and never switches desktops. The isolated
runtime profile avoids the user's Cua config. Both platforms remove inherited `CUA_*` settings and explicitly
set standard permission mode, disable unrestricted mode, and set
`CUA_DRIVER_RS_TELEMETRY_ENABLED=false` and `CUA_DRIVER_RS_UPDATE_CHECK=false`.

macOS preserves the signed `CuaDriver.app` at the stable lunR-owned path
`~/.lunr/desktop/runtime-darwin-arm64/CuaDriver.app` and verifies its signature
with `codesign --verify --deep --strict`. It never re-signs the bundle.
LaunchServices selects that exact app path with `open -n -g -W -a`, not its
shared bundle id or the user's `/Applications` installation. Explicit `--env`
arguments pass telemetry/update/permission settings and a private HOME to the
daemon. The private HOME also isolates the upstream default PID/config files.
A private Unix socket carries the MCP proxy connection. A private stdin FIFO
and the pinned `--parent-liveness-stdio` option tie daemon lifetime to lunR.
Shutdown uses the private endpoint's PID-bound request and waits for the owned
app to exit. Startup and shutdown have time limits. These construction and
cleanup paths have local tests, not macOS execution evidence.

Release staging creates `@ashx-j/lunr-computer-win32-x64`,
`@ashx-j/lunr-computer-win32-arm64`, and
`@ashx-j/lunr-computer-darwin-arm64`. Each package contains one unchanged archive,
the MIT license, and a manifest with `os` and `cpu`. There are no install scripts.
The payload packages follow the CLI release version, independently of the upstream
runtime version. The staged CLI declares exact optional versions. npm installs
only the matching payload; `--ignore-scripts` works. Missing optional dependencies
leave the CLI usable and produce a reinstall instruction when computer use needs
the runtime. Unsupported hosts have no native discovery tool.

The CLI tarball is about 10.7 MB, without runtime archives. Packed payload sizes
are about 28.8 MB for Windows x64, 27.2 MB for Windows arm64, and 69.8 MB for
Apple Silicon. These are decimal sizes, not extracted runtime sizes.

Workspace manifests and locks keep unpublished native dependencies out of
ordinary developer installs. `scripts/publish.mjs` injects them into the staged
CLI shrinkwrap and standalone installer lock. Public lock rewriting updates both
package names and tarball filenames. Publication validates all seven packages,
then publishes payloads before the CLI. A future release needs production
approval and an unpublished CLI version. The current 0.2.19 packs are local
validation artifacts, not newly published packages.

`scripts/build-binaries.sh` and `copy-binary-assets` copy only the selected opaque
archive into `native/computer-use` beside the executable. They preserve the macOS
archive without extracting or signing it. Routine builds stay offline. Release
preparation may fetch only the pinned official archives, then verifies their
sizes and hashes. Both npm and GitHub binary publication stop on the current
development-only approval.

An installed payload package must match the CLI version. A CLI upgrade that keeps
the same runtime bytes can reuse the verified cache. A changed or older cached
runtime fails closed rather than replacing a possibly running app. After all
owned processes stop, removing the inactive lunR runtime directory allows a fresh
extraction at the same stable macOS path.

## Verification and remaining gates

Local verification includes actual Windows initialize/tools/list and a
metadata-only `health_report`, with capture and accessibility checks excluded.
The binary reported 0.28.1 and 57 tools. Health results include human-readable
text and `structuredContent`. Its `session_active` check reports MCP activity,
not an unlocked or input-ready desktop. A separate real Windows metadata probe
confirmed an active session and Default input desktop without screen, AX, or
input calls. Snapshot identity and operation mapping
were checked against the exact released tool schemas and source; no live
snapshot was taken.

Focused tests cover policy, result interpretation, image coordinate mapping,
new GUI operation mapping, interrupted initialization, partial shutdown,
settings/session tool rosters, real separate-process contention and death,
orphan-runtime ownership, cache tampering, redirected paths, concurrent
extraction, and the fresh gateway cron factory's approval/disposal lifecycle.
The current verification passes 132 focused Vitest tests across 12 files and
eight archive/package tests. All five offline production builds, including the
coding-agent Node bundle, pass. Touched native TypeScript lint and the repository's
relative-import, workflow-publication, browser-smoke, and diff checks pass.

A loopback fixture registry served all seven public-name tarballs without changing
their bytes. A fresh Windows install used `--ignore-scripts`, fetched only the host
payload, then passed archive validation and first-paint/first-request fixtures
after relocation. Separate npm installs selected the correct package for each
supported OS/CPU combination and no package for Linux. An omitted-optional install
returned the expected missing-payload error. The shipped installer lock passed
`npm ci --ignore-scripts`. Standalone asset tests copied and rechecked all three
opaque archives. No installed app or desktop operation ran in these packaging
tests. Cross-platform npm selection on Windows is not macOS runtime acceptance.

The first-request fixture strips inherited subagent environment state before
checking the default tool inventory. The supported-host inventory includes only
`computer_load`; detailed computer tools remain lazy. The unsupported-host
baseline is unchanged.

To repeat local distribution checks after the offline build, prepare the pinned
archives with `scripts/bundle-computer-use.mjs`, create an empty temporary pack
directory, then run:

```sh
node scripts/generate-computer-use-manifest.mjs --check
node --test scripts/check-computer-use-release.test.mjs scripts/computer-use-packages.test.mjs
node scripts/publish.mjs --dry-run --pack-dir /absolute/temporary/pack-directory
node scripts/check-computer-use-install.mjs /absolute/temporary/pack-directory
```

The install checker uses a loopback registry for the local public packages and
npm's public registry for external dependencies. It isolates npm configuration,
cache, and install directories and removes them afterward. It does not publish.
These checks do not certify desktop behavior.

External acceptance gates remain:

- Windows locked, disconnected, UAC, and integrity-state acceptance for the
  metadata admission check and the actual driver.
- Authorized native and Electron fixture desktops, Unicode, moved/resized
  windows, display scaling, stale accessibility handles, application exit,
  outcome verification, and cancellation during held input.
- Real macOS signature/notarization, TCC, LaunchServices/FIFO environment,
  coexistence, upgrade, and shutdown acceptance.
- Real macOS and Windows arm64 runtime installation and launch. Their npm
  selection and unchanged archive copying pass locally, but their hardware
  execution and upgrades remain unverified.
- Full standalone executable acceptance. Payload asset copying passes; this
  verification did not compile and exercise every Bun target.

## Privacy and rollback

GUI actions are outside lunR's filesystem rollback. Images, accessibility text,
and typed text can enter selected-provider requests and saved sessions.
Disabling driver telemetry does not disable lunR session storage. Application
content is untrusted task data, never authorization. OS permissions, locked
desktops, UAC, and integrity restrictions still apply.
