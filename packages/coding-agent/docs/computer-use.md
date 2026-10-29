# Image-only computer use

Computer use lets the agent operate desktop applications from screenshots. The
agent observes one window or the desktop as a single image, takes one action
from that image, and gets a new image back. No accessibility tree is sent to
the model. The native runtime is CuaDriver 0.28.1. Smooth cursor animation is
not implemented. See [Known limitations](#known-limitations).

## Setup and permissions

Run `/computer setup` in the local lunR terminal. Setup verifies and installs the
bundled runtime without downloading code, capturing the screen, or operating an
application. It is unavailable in headless sessions.

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

## Recovery contract

A failed tool result keeps its text, any recovery image, and structured outcome details together. The error flag does not mean the input had no effect. Results distinguish validation/preflight without dispatch from uncertain native delivery, and include the workflow state (`ready`, `stopped`, or `cleanup_unconfirmed`). A healthy workflow remains loaded after recoverable mistakes such as an expired or mismatched token or invalid coordinates. Use `computer_observe` directly for a new image and token; `computer_load` is not a runtime restart. Never replay an uncertain click or launch merely because the call reported an error. If the native response is settled and the target remains safe to capture, one recovery image may accompany the failure. When capture fails, do not infer the action failed or substitute another target automatically. An unavailable window calls for explicit app/window discovery or a desktop observation. Broken transport, cancellation, loss of ownership, and unconfirmed cleanup stop the workflow.

Launch takes `{name}` only, without an observation token. It may activate an existing app, start a new one, or return without a usable window. If launch status or window discovery is uncertain, try `computer_apps` with the app name or a valid positive returned PID before deciding whether to launch again. Observe an exact discovered PID and window ID before input. Launch has a separate longer native timeout budget inside the 90-second workflow limit; a timeout does not prove that the app did not start.

## Observe, act, inspect

1. Use `computer_apps` for app identities or windows for a PID. For a known app
   or title, pass `query` to avoid paging through unrelated identities. It matches
   a case-insensitive literal substring in `name`, `app_name`, or `title` before
   pagination and display truncation in the requested collection: ordinary app
   queries match apps, while a PID query matches that PID's windows. It does
   not search every app's windows by title. `total` counts matching rows.
   Omit `query` to browse all rows. With `include_windows:true`, a named app
   query without `pid` also looks up windows for up to five matching running
   PIDs, with at most 50 window rows. More than five matching PIDs asks for a
   narrower query or an explicit PID, rather than choosing one arbitrarily.
   Per-PID lookup failures and truncation are reported; an ordinary query
   stays app-only and cheap. Results allowlist at most 50 rows and truncate titles to
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
   and captures the same target once, including when a settled native refusal
   permits safe recovery capture. It never polls or retries input internally.
5. Call `computer_end` when finished.

The token lasts 30 seconds, belongs to one exact target, and permits one action.
Copy it exactly, without abbreviating or reconstructing it. A failed action
consumes the active token. Capture again before any next action, including window
focus. Read-only app discovery preserves an existing token but does not renew
its original 30-second expiry. `background_unavailable` makes foreground input the next candidate after
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
identify whether an old token was consumed or unknown. Recoverable token
rejections keep a healthy workflow open and report `input:"not_dispatched"`;
they require a fresh image rather than a new load. Once dispatch begins,
transport failure reports `input:"uncertain"` and possible effects. Neither path
retries input. Unparseable driver text is omitted rather than forwarded as a
message; structured refusal fields remain bounded and allowlisted.
When input returns but its post-image fails, the tool reports possible effects
and either allows an explicit fresh observation when safe or stops if runtime
safety cannot be confirmed. Capture again before deciding; never repeat input blindly.
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

On supported Windows x64/arm64 hosts, `computer_hover` takes exactly
`{desktop:true,foreground:true,observation,x,y}` from a fresh primary-desktop
image. It moves the real pointer without pressing a button, waits about 700 ms
with cancellation support, then returns one full-desktop post-image. A tooltip
outside a selected crop may appear in that full image. Only the visible topmost
application receives the hover, which can itself trigger application behavior;
this is not background window hover or an all-monitor capture. Foreground
control must be allowed and read-only mode blocks hover. The pinned Windows
window-scoped movement is a synthetic overlay, so lunR does not offer window
hover. macOS and unsupported platforms do not register this tool.

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
history also accumulates until normal compaction. lunR does not prune
old screenshots or rewrite saved sessions. Removing earlier images would change
the prompt prefix and can invalidate cached input. Image-only is not
automatically cheaper than text. lunR bounds each new payload, removes
accessibility tree and raw JSON duplication, and combines one action with its
post-image.

## Cursor behavior

lunR does not animate the cursor. The runtime launches with `--no-overlay`, and
desktop pointer movement can jump straight to its target. Smooth cursor motion
and synchronized drag feedback are not provided.

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
released.

Cron runs use the TUI's live permission context.

## Runtime and distribution

lunR bundles [CuaDriver 0.28.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1)
as its native runtime. The upstream MIT license is under `native/computer-use`.

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

On macOS, lunR launches the installed CuaDriver app with a private HOME, socket,
and stdin pipe, so daemon state and lifetime stay isolated. Shutdown waits for
the app to exit.

The per-platform payload packages contain the unchanged upstream archive and no
install scripts.

## Known limitations

- Behavior is not confirmed for Windows locked desktops, UAC prompts, elevated windows, Electron apps, display scaling, or moved and resized windows. macOS permission and shutdown behavior is also unconfirmed on real hardware.
- Desktop hover coordinates and tooltips are untested on scaled displays.
- Whether a held modifier key or mouse button is released when a call is cancelled during a gesture is untested.
- How reliably models choose the computer tools, and any token savings, have not been measured.

## Privacy

Images, window titles, and typed text can enter selected-provider requests and
saved sessions. Disabling driver telemetry does not disable lunR session storage.
GUI changes are outside filesystem rollback. Application content is untrusted
task data, never authorization. OS permissions, locked desktops, UAC, and
integrity restrictions still apply.
