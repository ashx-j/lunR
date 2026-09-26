# Image-only computer use

The image-only implementation shipped on `lunr-dev` as `0.2.21-dev.12.1`
and received user testing. Automated validation passed on the dev integration.
This PR builds on that implementation without dev-channel naming or update
changes, and repairs failure reporting and unchanged-image detection. Smooth cursor animation is not implemented. Production
publication remains blocked pending the native runtime's separate approval.

## Setup and permissions

Run `/computer setup` in the local lunR terminal. Setup verifies and installs the
bundled runtime without downloading code, capturing the screen, or operating an
application. It is unavailable in headless and gateway sessions.

Windows needs an active, unlocked desktop. On Apple Silicon macOS, setup prints
the exact installed `CuaDriver.app` path. Add that app to Accessibility and
Screen & System Audio Recording in System Settings > Privacy & Security, then
restart lunR. Older macOS versions call the second grant Screen Recording.
Only the user can grant these permissions. Setup leaves an existing
`/Applications/CuaDriver.app` alone.

Computer use and Allow foreground control default to on. Windows x64/arm64 and
Apple Silicon expose `computer_load`; detailed tools load on demand. Linux and
Intel macOS have no native discovery tool. All computer tools except release
require an image-capable model. There is no text-only accessibility fallback.
Gateway sessions operate the gateway host, not the chat client's device.

`computer_end` releases without approval. Read-only allows relevant observation
and release, but blocks mutation. Yolo and Auto permit input. Auto allows
requested, implied, or necessary GUI work without lunR per-call prompts. In
Yolo, ask before introducing GUI work into an otherwise non-GUI task. These
intent rules are agent guidance, not a natural-language authorization classifier.

Prefer background window input. Foreground window input requires a verified
background failure and a fresh image. Desktop input requires `desktop=true` and
`foreground=true`. Disabling foreground control blocks desktop input, foreground
window input, launch, and window management. An application can still change its
own focus after background input.

Native tools are excluded from children and refuse child execution. Children
with shell access are not OS-sandboxed. No raw driver administration, update,
recording, or permission tool is exposed.

## Observe, act, inspect

1. Use `computer_apps` for app identities or windows for a PID. For a known app
   or title, pass `query` to avoid paging through unrelated identities. It matches
   a case-insensitive literal substring in `name`, `app_name`, or `title` before
   pagination and display truncation. `total` counts matching rows. Omit `query`
   to browse all rows. Results allowlist at most 50 rows and truncate titles to
   240 characters. Pass `next_offset` as `offset` with the same PID and query to
   retrieve more matches. Lists refresh per call, so changing native order can
   shift page boundaries. PID zero
   identifies an installed app that is not running. Window `bounds` are native
   geometry, not screenshot coordinates.
2. Use `computer_observe` with an exact `pid` and `window_id`, or `desktop=true`.
   The result contains one image and a short coordinate/token record.
3. Choose one action from that image. Pass its `observation` token and coordinates
   in the returned image. The workflow applies the mapping; do not scale twice.
4. Inspect the post-action image before continuing. The tool executes one action
   and captures the same target once. It never polls or retries input internally.
5. Call `computer_end` when finished.

The token lasts 30 seconds, belongs to one exact target, and permits one action.
Copy it exactly, without abbreviating or reconstructing it. A failed action
consumes the active token. Capture again before any next action, including window
focus. `background_unavailable` makes foreground input the next candidate after
a fresh capture, if permitted. Do not substitute another background shortcut.
Token rejection does not prove foreground typing failed.

Every new observation invalidates the previous token before capture. Failed,
cancelled, or malformed captures issue no token. Old tokens cannot be replayed,
including after a successful action returns a new image.

Supported input is single, double, and right click with modifiers, a complete
press-drag-release gesture, scrolling at image coordinates, Unicode text, and
keys or modifier shortcuts. Window text/keys can use image coordinates or the
observed focused field. Desktop text/keys use the observed focused field only;
change focus with a separate grounded click.

`computer_window` supports `frame` in native window-bounds units and `focus` on
an exact observed window. Minimize/restore uses a grounded image click on a
visible control. The pinned driver has no portable minimize/restore RPC.
`computer_launch` returns bounded app metadata, not an inferred input target;
capture an exact window before acting.

A successful transport or a changed image does not prove the intended application
effect. Results preserve partial/unverifiable outcomes and bounded refusal codes.
Pre-dispatch failures report `input:"not_dispatched"` and state that this call
sent no input. They do not establish whether earlier calls had an effect. Token
codes distinguish a missing active observation, a mismatched token, a wrong
target, and expiry only while that state is available. A closed workflow cannot
identify whether an old token was consumed or unknown. Once dispatch begins,
transport failure reports `input:"uncertain"` and possible effects. Neither path
retries input. Unparseable driver text is omitted rather than forwarded as a
message; structured refusal fields remain bounded and allowlisted.
When input returns but its post-image fails, the tool reports possible effects
and stops the workflow. Capture again before deciding; never repeat input blindly.
After an unchanged post-image, the same action against identical captured pixels
is refused. Pixel identity hashes decoded full-image RGBA values and dimensions,
not PNG encoding bytes, before cropping or resizing. Full captures reuse the
image processor's decode, and crops reuse the existing full-image decode. Click signatures normalize omitted left-button/single-click/empty
modifier defaults and modifier order. Three consecutive unchanged full observations
stop polling in that workflow. Crops are explicit requests, not an automatic retry loop.

Partial typing retains validated `requested_chars`, `delivered_chars`, `retryable`,
and `retry_from_character` when supplied by the driver. Counts must be safe integers
within the submitted text's Unicode code-point length, capped at 20000; the retry
index must equal the delivered count. The index is zero-based in Unicode code
points, not UTF-16 units. Verify the field in a fresh image before considering a
remaining suffix. `retryable` is driver advice, not permission or proof that
repeating input is safe. The workflow never retries typing automatically.

## Image contract and cost limits

Window capture requests `include_accessibility_tree:false` and
`include_screenshot:true`. Neither native accessibility trees nor duplicate raw
JSON reach the model. The macOS driver still reads minimal native accessibility
facts for window identity and background-input safety. Windows window discovery
can use UIA as a fallback. Image-only describes application observation sent to
the model, not the removal of every native accessibility API call.

Window capture requests a 2560-pixel maximum. The runtime can impose a lower
configured ceiling, so this is not a promised capture resolution. The workflow
checks actual PNG dimensions against native screenshot metadata and rejects
invalid frames. Primary-desktop capture is tree-free and uses the native PNG.
Desktop coordinates map back to that PNG once; macOS `scale_factor` is not an
additional multiplier.

Returned images have a maximum 1280-pixel edge, one million pixels, and 1.5 MiB
of base64 payload. The existing image processor bounds dimensions and encoding
size. The workflow refuses images it cannot decode or map. Source PNGs also have
allocation limits. These are engineering bounds, not measured token savings.

For small text or controls, request `crop:{x,y,width,height}` with the latest
observation token. The rectangle uses that returned image's pixels. The workflow
captures fresh pixels, maps the rectangle into the full capture, and sends only
the crop. Its record gives the source dimensions, crop offset, and separate x/y
ratios. Changed source dimensions or reported window bounds reject the crop;
request a full image again. Cropping cannot recover detail absent from the native
capture. Post-action captures return the full target so dialogs outside a crop
remain visible.

Saved sessions retain the returned screenshots. Provider-facing screenshot
history also accumulates until normal compaction. This change does not prune
user images, rewrite saved sessions, or implement a generic rolling history
filter. A targeted `context` hook could remove old computer screenshots while
leaving sessions intact, but a rolling cutoff changes an earlier prompt prefix
and can invalidate cached input. That tradeoff needs approved provider measurements
before adopting a retention policy. Image-only is not automatically cheaper than
text. Current cost controls bound each new payload, remove tree/JSON duplication,
and combine one action with its post-image.

## Cursor status

Cursor animation remains a separate native-runtime decision. The inherited
runtime launch still uses `--no-overlay`. Upstream Windows drag animation uses a
timer separate from actual input, and desktop pointer movement can teleport.
This branch does not claim smooth actual-cursor motion or synchronized drag
feedback. Any eventual animation must stay local, preserve full gestures and
cancellation, and send zero intermediate frames to the model.

## Ownership and cancellation

An OS-account lease spans observations and actions, independent of settings
profiles. Competing workflows receive busy rather than queueing. Calls within a
workflow serialize. One cross-process lock covers creation, atomic replacement,
and deletion of the owner record. A separate lock protects runtime installation.
A live owner is not displaced because its heartbeat is late.

After MCP initialization and before any driver tool dispatch, the adapter records
the transport PID and, on macOS, daemon PID. Missing identities or failed lease
updates refuse dispatch. Recovery requires both owner and recorded runtimes to
have exited. PID reuse and malformed owner records fail closed. A crash during
initialization can leave an unrecorded idle runtime that received no input.

Release, cancellation, agent end, settings changes, and session shutdown close
the owned runtime before releasing the lease. Queued work cannot survive
cancellation. Unconfirmed shutdown retains ownership. Cancellation cannot retract
already delivered input, and forced termination does not prove held input was
released. Driver-internal helper lifetime and held-input cancellation still need
native acceptance.

Gateway cron creates fresh permission contexts with the configured default mode,
without gateway approvals or its approval handler. Read-only blocks input, and
missing approval blocks operations that still require confirmation.
Session shutdown precedes disposal, even after partial extension binding failure.
TUI cron continues to use its live permission context.

## Runtime and distribution

The development pin is [CuaDriver 0.28.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1),
source `d8028a7943087ee258dc1b4d19dc12a7cd27669c`. Archive identities and approval
are in `scripts/computer-use-release.json`; `release.generated.ts` derives from
it. The upstream MIT license is under `native/computer-use`. No runtime pin or
native binary changed in the image-only workflow work.

The runtime resolves the host's optional payload package or matching archive
beside a standalone executable. It verifies the archive, extracts a fresh
reference tree, and checks cached files/helpers against it. Redirected paths and
escaping symlinks are refused. Installers do not overwrite an existing runtime.
After confirming all owned processes stopped, an inactive cache can be removed
for reinstallation. Runtime code is never downloaded at first use.

Windows uses system `tar.exe` and an isolated `mcp --direct --embedded
--no-overlay` process. A hidden system PowerShell metadata probe refuses session
zero, disconnected sessions, and inaccessible/non-Default input desktops. It
never switches desktops. Both platforms isolate profiles, strip inherited
`CUA_*`, set standard permission mode, and disable telemetry/update checks.

macOS preserves the unchanged signed app at its stable lunR-owned path, verifies
its signature with `codesign --verify --deep --strict`, and launches that exact
path through `open -n -g -W -a`. A private HOME, socket, stdin FIFO, and
`--parent-liveness-stdio` isolate daemon state and lifetime. Shutdown uses the
private PID-bound endpoint and waits for the app to exit. No re-signing occurs.

Release staging creates exact-version host-specific optional payload packages.
They contain unchanged archives and no install scripts. Workspace manifests keep
unpublished payload dependencies out. Standalone asset copying selects one
opaque archive. Stable publication remains gated on production approval and a
new CLI version. Dev-channel update/publication changes were not ported here.

## Verification and remaining acceptance

After integrating v0.2.24 master, all five offline package builds and the Node
bundle pass. With the PR #118 baseline repairs integrated, validation passes
391 focused tests across 31 files and eight archive/package tests. Installation and archive staging tests now create inert
fixtures, so source tests need no native release payload. The Windows installation
test exercises real extraction, locking, cache reuse, and helper-tamper rejection
without executing either fixture file. Fake-driver tests cover exact-token
rejection with zero action dispatch, background refusal followed by fresh-capture
foreground input, and uncertain or partial post-dispatch outcomes. Real PNG
fixtures reproduce encoding-independent pixel identity and preserve crop mapping.
First-paint and first-request checks pass for both browser settings; removing only
`computer_load` reproduces master's unchanged tool hashes.

All three pinned upstream archives match their committed byte counts and SHA-256
hashes. Seven public-name tarballs staged with those unchanged real payloads pass
relocated installation, first requests, all supported OS/CPU selections, omitted
optional-payload recovery, and standalone installer `npm ci --ignore-scripts`.
Staging validates rewritten JavaScript and declaration imports and exact payload
versions in both locks. These checks ran on Windows x64 without launching the
native driver; OS/CPU selection tests do not establish operation on other hardware.
Archive integrity and packaging are verified, but native signing, permission and
input acceptance remain separate. Production approval is still development-only;
publication requires separate approval and a new CLI version.

The PR also incorporates the separately tracked baseline repairs from PR #118.
That work fixes AI catalog subpath resolution in extension loading and updates
fixtures for current gateway, shutdown, provider and subscription contracts.
Its 152 focused tests across ten files pass. The complete Ubuntu log before
those repairs records 101 coding-agent failures across 27 suites and 11 AI
failures, more than the subset exposed by check annotations. Agent passes
181/181 in that run. Clean full-suite CI still requires broader baseline work;
local Windows-only diagnostics are not evidence of Ubuntu failures.
The automated checks did not operate a desktop or launch CuaDriver.

A separately authorized Windows x64 smoke test used this branch's compiled
computer tools with the real pinned runtime. It launched a new blank Notepad
window, captured that exact window, and typed a fixed 39-character phrase using
background delivery. The post-action screenshot showed the complete expected
text and character count. The driver's outcome remained `unverifiable`; the
image established the application effect. `computer_end` confirmed shutdown and
released the desktop lease. No document was saved or installed CLI changed.
This verifies basic launch, window capture and background text input only.
Foreground recovery, held-input cancellation and broader platform acceptance
remain unverified.

The dev integration passed all five offline package builds, the Node bundle,
265 focused tests across 23 suites, and eight archive/package tests. A real
Photon fixture checks cropped pixels and coordinate mapping. First-paint and
first-request checks passed with the regenerated supported-host fingerprint;
removing only `computer_load` reproduced the unchanged unsupported-host baseline.
Seven local dev tarballs passed relocated installation, OS/CPU payload selection,
omitted-optional handling, and installer-lock checks. The dev publication workflow
also passed. These historical results describe the dev integration. The current branch's
stable packaging checks are recorded above.

The user reported testing the published dev build; specific applications and
scenarios were not supplied. This does not establish full platform acceptance.
Native gates remain Windows locked/UAC/integrity states, Electron/native apps,
display scaling and moved/resized windows, Unicode, held-input cancellation, and
macOS TCC/LaunchServices/FIFO/shutdown on hardware. Cursor/runtime changes need
a separate scoped decision before implementation. Provider token savings remain
unmeasured. An offline fake-driver discovery comparison finds a named app at row
118 of 139 synthetic apps in one query instead of three unfiltered pages. It
returns one identity instead of 139 and 147 result-text characters instead of
8699. The loaded computer-tool definitions grow by 230 serialized characters;
the first-request definitions are unchanged because detailed tools load on demand.
These are call and text-payload measurements, not model tokens or billing. The
comparison uses no desktop, provider, screenshot resizing, or history pruning.

## Privacy

Images, window titles, and typed text can enter selected-provider requests and
saved sessions. Disabling driver telemetry does not disable lunR session storage.
GUI changes are outside filesystem rollback. Application content is untrusted
task data, never authorization. OS permissions, locked desktops, UAC, and
integrity restrictions still apply.
