## Recommendation

Add a first-party, optional **Playwright-backed `browser` tool**. Keep it separate from `web_search` and `fetch_content`.

Use:
- `web_search` for discovery and current information.
- `fetch_content` for ordinary readable pages, documents, repos, videos, and static extraction.
- `browser` only for JavaScript-rendered pages, authenticated flows, forms, multi-step interactions, local web-app testing, and visual checks.

This is the smallest durable design. It avoids making all users install a browser, avoids a large MCP tool catalog in every prompt, and lets lunR enforce its own permissions.

## What lunR has today

- `packages/coding-agent/src/builtin-extensions/pi-web-access/index.ts` provides `web_search`, `fetch_content`, and stored-content retrieval. It can open the search curator in the user's normal browser, but it does not automate that browser.
- `packages/coding-agent/src/builtin-extensions/pi-web-access/extract.ts` uses HTTP, Readability, Jina, Parallel, and Gemini fallbacks. It explicitly detects JavaScript-rendered pages as an extraction failure.
- `packages/coding-agent/src/builtin-extensions/pi-mcp-adapter/` already supports stdio, SSE, and Streamable HTTP MCP servers, lazy connection, cached direct tools, and session shutdown. A user can configure Microsoft's `@playwright/mcp` today without a lunR implementation.
- `packages/coding-agent/src/builtin-extensions/index.ts` defers web and MCP extensions until after TUI first paint. That is the right loading model for browser support.
- `packages/coding-agent/package.json` has no Playwright or Puppeteer dependency.
- Browser cookie access currently exists only for Gemini Web extraction and only on macOS/Linux. `chrome-cookies.ts` does not automate a browser and returns no Windows browser configuration.

## Proposed MVP

One session-scoped `browser` tool, imported only on first use:

| Action | Purpose |
|---|---|
| `open` / `navigate` | Start headless Chromium and load an HTTP(S) URL |
| `inspect` | Return a bounded ARIA snapshot or focused semantic query |
| `act` | Click, fill, check, select, or press using role/name targets |
| `tabs` | List, open, select, close tabs |
| `screenshot` | Explicit visual fallback only |
| `close` | Close browser and erase ephemeral state |

Use Playwright locators such as role and accessible name, not coordinates or arbitrary `evaluate()` JavaScript. ARIA snapshots are structured YAML with roles, names, state, and text, which makes them much cheaper and more reliable for an agent than screenshots. Screenshots should be opt-in for canvas, charts, layout, or visual regression questions. Playwright exposes programmatic ARIA snapshots directly. [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots)

Keep a `Browser` and one isolated `BrowserContext` in memory for the lunR session. Close both on `session_shutdown`, cancellation, and idle timeout. Start unauthenticated and ephemeral by default. Do not import existing Chrome cookies or persist login state in the MVP.

For a later authenticated mode, require an explicit user action to create/select a named profile. Store state outside the project and never return cookies or storage values to the model. Playwright warns that storage-state files can impersonate the user. [Playwright authentication](https://playwright.dev/docs/auth)

## Why direct Playwright over browser MCP

| Option | Verdict |
|---|---|
| Direct Playwright library | **Recommended MVP.** One small lunR schema, first-party permission checks, predictable lifecycle, TypeScript-native. |
| Existing MCP plus `@playwright/mcp` | Good zero-code escape hatch now. Not the product default. Its large action catalog and snapshots cost context, and MCP actions need lunR-specific permission handling. |
| Playwright CLI plus a skill | Worth trying manually. Microsoft calls it more token-efficient for coding agents, but a shell-driven integration has weaker lifecycle, tool rendering, and permission semantics. |
| Chrome DevTools MCP | Good optional debugging/performance specialist. Chrome-only, and its README says telemetry is enabled by default unless opted out. Not a general browser MVP. |
| Stagehand / Browserbase | Credible agent-oriented option with self-healing and hosted browsers, but adds external browser/model/API-key cost and sends browsing state to a third party. Keep as a user-configured MCP option, not builtin. |

Microsoft's own comparison says MCP suits persistent exploratory loops, while its CLI is more token-efficient because it avoids loading large schemas and full accessibility trees. That supports lunR's small single-tool design rather than exposing the whole MCP catalog. [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Playwright CLI](https://github.com/microsoft/playwright-cli)

## Installation, Windows, and startup

- Add Playwright only as an optional capability. Do not download a browser during `lunr` install, startup, or the first tool call.
- Provide an explicit future setup command that installs **Chromium only**, or return a clear unavailable result with the exact setup instruction.
- Playwright supports Chromium, Firefox, WebKit, Chrome, and Edge. Chromium is enough for MVP. It supports Windows and stores downloaded browsers under `%USERPROFILE%\AppData\Local\ms-playwright`; each browser takes hundreds of MB. [Playwright browsers](https://playwright.dev/docs/browsers)
- The extension factory and tool schema must stay light. Dynamically import Playwright inside first execution, then launch only on `open`. This fits the deferred extension pattern in `packages/coding-agent/src/builtin-extensions/index.ts` and protects first paint.
- Later measure cold first-use on Windows. Expect seconds of process startup and meaningful memory, rather than the low latency of `fetch_content`.

## Permissions and security

**High finding:** `packages/coding-agent/src/core/permissions.ts` only classifies named builtins as mutating. The generic `mcp` tool and generated direct MCP tool names are not classified there. `packages/coding-agent/src/builtin-extensions/pi-mcp-adapter/direct-tool-executor.ts` can call remote tools without consulting lunR's manual-mode gate. Therefore a browser MCP server should not be advertised as permission-equivalent to a first-party browser tool.

For the proposed tool:
- Treat `inspect`, bounded snapshot, screenshot, and tab listing as read-only.
- Require manual approval for every `act`, file upload, download, browser permission grant, persistent-profile use, and any future destructive action. A click can submit a purchase or delete data.
- Omit arbitrary page evaluation, uploads, downloads, clipboard, geolocation, camera, microphone, cookie tools, CDP attachment, and browser-extension attachment from MVP.
- Default to HTTP(S), a clean context, browser sandbox on, short action/navigation timeouts, an idle shutdown, and artifact storage under the agent directory.
- Treat page text, ARIA labels, WebMCP tools, and tool descriptions as untrusted content, not instructions.
- Reuse or extend the existing SSRF policy for navigation. Browser routing needs redirect-aware validation if private-network access is restricted.
- Any browser capability is still not a sandbox. lunR's own security documentation says isolation requires an OS/container boundary.

The MCP security guidance also warns that local MCP servers execute with client privileges and should have explicit user consent. [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

## Rough implementation scope

Medium, roughly:
- 1 deferred extension and lazy module loader.
- Session-owned browser manager with abort, timeout, cleanup, and artifact retention.
- A compact tool schema and TUI renderer.
- Permission classification and confirmation UI for browser actions.
- Browser setup/status command and Windows-focused diagnostics.
- Focused tests for lazy import, absent browser, state cleanup, action confirmation, output truncation, and first-paint schema stability.

## Decisions Ash needs to make

1. Should browser support be built-in optional setup, or remain only an MCP/extension recipe?
2. Is ephemeral unauthenticated browsing enough for v1? I recommend yes.
3. Should local development URLs be allowed by default, or require an allowlist?
4. Should browser actions in `auto` mode still require confirmation for submissions and uploads? I recommend yes for those irreversible actions.
5. Do you want a future authenticated profile mode at all? It is useful, but it changes the risk level substantially.