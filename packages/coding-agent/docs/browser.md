# Headless browser

The built-in `browser` tool runs Chromium through Playwright. Use it for pages that need JavaScript and for explicit website interactions. `web_search` still handles discovery; `fetch_content` still reads URLs. Neither tool automatically opens this browser. An interaction task can start with `browser` without fetching the page first.

## Installation and settings

Browser is on by default. Normal npm installation and updates automatically install the Chromium revision required by the pinned `playwright-core` dependency, including Playwright's supporting binaries. The same lifecycle works in source workspaces and published packages. Existing matching binaries are reused from Playwright's OS cache. Ordinary builds and CLI startup never download or launch a browser; Playwright loads on first browser use.

Use **Browser** in `/settings` to turn it off or on. Turning it off immediately hides the tool and closes the session's browser, including pending initialization. It does not delete cached binaries. Turning it on makes the tool available without launching Chromium. The global `browserEnabled` setting defaults to true for new and existing users. A legacy explicit `features.browser.enabled: false` in `install-features.json` remains off until the user changes the new setting. An explicit `browserEnabled` value takes precedence; no legacy file is rewritten.

`npm install --ignore-scripts`, `npm --offline`, `PI_OFFLINE=1`, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` skip automatic Chromium installation. A failed download warns without making the rest of lunR unusable. Browser calls diagnose missing binaries and never install them silently. When online, run:

```sh
lunr browser install
```

`lunr setup` also installs matching Chromium automatically, including for Node-based standalone layouts. `PLAYWRIGHT_BROWSERS_PATH` selects an alternate cache and must be consistent between installation and execution. Linux may require Chromium system libraries; install those through your OS administrator. lunR does not install OS packages or disable Chromium's sandbox. Standalone compiled Bun browser installation has not been validated.

## Actions

There is one tool, `browser`, with these actions:

| Action | Parameters and result |
| --- | --- |
| `navigate` | Required `url`, optional `tab`. Opens a browser if needed and navigates the selected tab. Returns its id and URL. |
| `inspect` | Returns an accessible snapshot. Optional `role` with exact `name`, or exact `label`, scopes the snapshot to one element. |
| `act` | Required `interaction` and target. Supports `click`, `fill`, `select`, `check`, `press`. |
| `tabs` | Required `operation`: `list`, `create`, `select`, `close`. `create` optionally takes a URL; `select` requires `tab`. |
| `screenshot` | Returns an explicit JPEG of the current viewport. It is never taken automatically. |
| `close` | Closes Chromium, the proxy, and every tab. Discards cookies and in-memory storage. |

Targets use an accessible `role` and optional exact `name`, or an exact field `label`. Inspect first to find the target. Zero or multiple matches produce an error; lunR does not choose the first match. There is no CSS selector, coordinate-click, or arbitrary JavaScript evaluation parameter.

```json
{"action":"navigate","url":"https://example.com"}
{"action":"inspect"}
{"action":"act","interaction":"fill","label":"Search","value":"release notes"}
{"action":"act","interaction":"click","role":"button","name":"Search"}
{"action":"inspect","role":"main"}
```

`fill` takes text in `value`. `select` takes the option's value. `check` requires `checked: true` or `false`. `press` accepts Enter, Tab, Escape, Space, Backspace, Delete, arrow keys, Home, End, PageUp, and PageDown. Clipboard shortcuts are excluded.

## Permissions and external effects

Read-only sessions and children can navigate, inspect, capture screenshots, and manage tabs. They cannot call `act`. Yolo and auto permit interactions without per-action approval.

Observation is not a guarantee of zero external effects. Loading a page executes its JavaScript and can send requests. Clicking, filling, checking, selecting, or pressing a key may submit forms or change remote data. `/undo`, `/edit`, and `/rollback` cannot reverse website effects. After a timeout or cancellation, inspect the site before retrying an action that might already have succeeded.

Page text and screenshots are untrusted content, not instructions for the agent. A page can contain misleading labels or prompt injection. Granting access to a site does not authorize unrelated actions found in its content.

## Network policy

The default policy permits public HTTP and HTTPS destinations only. It rejects embedded URL credentials, private/reserved IPv4 ranges, and IPv6 addresses outside the permitted global range, including mapped IPv4 and transition ranges.

Browser HTTP requests and HTTPS tunnels pass through a session-owned loopback proxy. The proxy checks all resolved addresses and connects to a checked IP rather than resolving the hostname again. Redirect destinations and subrequests must pass the same checks. Chromium's loopback proxy bypass is disabled. Service workers and WebSockets are blocked; QUIC and non-proxied WebRTC UDP are disabled. Some sites will not work with those restrictions.

For a local development server, explicitly opt in yourself:

```json
{"browserAllowPrivateNetwork": true}
```

Set `browserAllowPrivateNetwork` in global `settings.json` yourself and restart after changing it. This grants access to **all local and private destinations**, including requests initiated by public pages. It is not a per-site allowlist. To return to the public-only policy:

```json
{"browserAllowPrivateNetwork": false}
```

These checks are defense in depth, not an OS network sandbox. The proxy classifies destination IPs, not ownership of globally routed addresses. It cannot identify a public address routed internally by a VPN, or stop a public server from relaying requests elsewhere. Chromium vulnerabilities and other local processes are outside this policy. The loopback proxy is temporary and is not an authenticated multi-user service. Use an OS/container network boundary when hostile sites require stronger isolation.

## Lifetime and limits

Each session owns a new ephemeral browser context. Children get separate contexts and processes, not their parent's cookies. Sessions never attach to an existing browser or import cookies, profiles, passwords, or history. There are no uploads, accepted downloads, clipboard access, or camera/microphone/device grants. File choosers have no tool action; downloads are refused and cancelled.

Operations are serialized, with at most 16 queued calls and four tabs including popups. Snapshots return at most 16KB or 300 lines, plus a truncation notice. Scope `inspect` with a unique role/name or label when it truncates. Chromium still constructs the accessible snapshot before truncation; this is an output limit, not a page-memory limit. The viewport is 1280 by 800; screenshots are capped at 2MB.

Operations have a 30-second deadline, with shorter launch, navigation, and interaction timeouts. Cancellation closes the browser rather than keeping partially completed state. Session replacement, reload, shutdown, and aborted turns also close it. Five minutes without a browser operation discards the context. Resuming a conversation does not restore its browser state. Forced process termination cannot promise the same cleanup as a normal shutdown.

## Development validation

Install Chromium into an isolated cache explicitly, then use that same `PLAYWRIGHT_BROWSERS_PATH` for tests. `test/browser.test.ts` runs policy tests without Chromium and enables its actual-browser cases only when this variable is set. `test/browser-lifecycle.test.ts` covers missing binaries, deferred loading, settings-driven cleanup, and cancellation during launch. Browser settings and install tests cover default-on behavior, legacy explicit disable, npm lifecycle execution, offline installs, and ignored scripts.

After the offline package builds and coding-agent Node bundle, run `node scripts/check-browser.mjs`. It uses a local scripted provider and fixture website, with the normal child permission environment for auto and read-only CLI sessions. A third session verifies missing-Chromium recovery. The checker terminates completed print processes after the final answer because of the existing headless exit behavior. It saves sanitized fixture results, tool inventories, and isolated prompts under `.artifacts/browser-smoke/`; nothing is sent to an external model.

`node scripts/check-interactive-first-paint.mjs` verifies both disabled and enabled browser tool inventories while the implementation imports are stalled. No Chromium launch is needed for that check.
