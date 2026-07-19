# lunR Basics: Branding, Boot Screen, Monochrome Theme

## Goal

Make lunR present itself as lunR everywhere a user looks at startup, replace the interactive
boot screen with a custom ASCII-art screen, and ship a single monochrome "moon" theme as the
default and only built-in theme.

This document is the complete spec. Every file path and line number below was verified by
codebase recon on 2026-07-18. If code has drifted, re-read the file before editing.

## Rules (from AGENTS.md)

- Work on a branch, not directly on master. Suggested branch: `feat/lunr-basics`.
- Read files before editing them. Touch only what this plan requires.
- Keep commits small: one per phase (4 commits total).
- After finishing, update the **Current State** section of `AGENTS.md` (build/test results,
  decisions made, what changed).
- Do NOT touch `~/.pi/` (pi's config). lunR uses `~/.lunr/`.
- `packages/coding-agent/src/builtin-extensions/` is upstream code. Do not rebrand it.

## Scope

IN:
1. Runtime branding pi → lunr (the bin is already `lunr`; the runtime identity is not).
2. Custom boot screen: `boot-ascii.md` art on the left, CLI details on the right.
3. New monochrome `moon` theme as default; remove `dark`/`light` built-ins; fix everything
   that references them.

OUT (deferred, do not do in this phase):
- Renaming `@earendil-works/pi-*` package scopes (327 files, separate task per AGENTS.md).
- pi.dev URLs / telemetry endpoints (`version-check.ts`, `changelog.ts`, `pi-user-agent.ts`,
  share-viewer URL). These still point at pi infrastructure; changing them is a product
  decision, not branding.
- `PI_CODING_AGENT` env var and `PI_CODING_AGENT_DIR` env var names (external contract).
- Internal docs/comments mentioning pi.

---

## Phase 1 — Runtime branding: pi → lunr

### Root cause

`packages/coding-agent/src/config.ts:489-491`:

```ts
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
```

`packages/coding-agent/package.json` has `piConfig: { configDir: ".lunr" }` but **no `name`
key**, so `APP_NAME` falls back to `"pi"` and `APP_TITLE` to `"π"`. Everything that uses
`APP_NAME`/`APP_TITLE` (help text, startup logo line, terminal title, quit command, export
filenames, debug log name) prints "pi".

### Changes

1. **`packages/coding-agent/package.json`** — add the name override:
   ```json
   "piConfig": {
     "name": "lunr",
     "configDir": ".lunr"
   }
   ```
   This single change fixes: `--help` usage lines, the startup logo line, terminal window
   title (`APP_TITLE` becomes `"lunr"`), `/quit` description, `pi-session-*.html` export
   names → `lunr-session-*.html`, and `pi-debug.log` → `lunr-debug.log`. Verify each of
   these after the change; do not hand-edit the call sites.

2. **`packages/coding-agent/src/modes/interactive/interactive-mode.ts:745-748`** — onboarding
   line hardcodes "Pi":
   ```ts
   `Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`
   ```
   Rewrite to use the brand: `` `Ask ${APP_NAME} how to use or extend it.` `` (APP_NAME is
   already imported in this file). Note: Phase 2 replaces this header block; coordinate the
   two edits so the final text appears once.

3. **`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3562`** —
   `"pi exiting due to uncaughtException:"` → use `APP_NAME`.

4. **`packages/coding-agent/src/cli/args.ts:232`** — help line
   `` `${APP_NAME} update [source|self|pi]   Update pi, extensions, or model catalogs` `` →
   change the literal `pi` words to `lunr`/`${APP_NAME}` where they mean the app.

5. **`packages/coding-agent/src/package-manager-cli.ts:154,157,164,167,171`** — update
   command help/examples say "Update pi...". Change user-facing "pi" to the app name. Keep
   the `pi` positional arg working (it is an alias for self-update; keep backward compat).

6. **`packages/coding-agent/src/main.ts:52`** —
   `'Hint: Start without extensions using "pi -ne".'` → use `APP_NAME`.

7. **`packages/coding-agent/src/core/project-trust.ts:25`** — trust prompt says
   "This allows pi to load..." → use `APP_NAME`.

8. **`packages/coding-agent/src/modes/interactive/components/first-time-setup.ts:56`** —
   `Welcome to ${APP_NAME}, the minimal coding agent.` — keep `APP_NAME` (now resolves to
   lunr) but drop "the minimal coding agent" → `Welcome to lunR.` Also lines 74-76: the
   analytics text says "within Pi" → reword to "within lunR".

9. **`packages/coding-agent/src/modes/interactive/components/earendil-announcement.ts:32`** —
   `"pi has joined Earendil"` is pi-specific news that is false for lunR. **Decision: disable
   the announcement.** Find where it is shown in `interactive-mode.ts` and remove that call
   site only. Leave the component file in place (deleting is out of scope).

10. **`packages/coding-agent/src/cli/startup-ui.ts:26-28`** — `OFFICIAL_PACKAGE_NAME`,
    `OFFICIAL_APP_NAME`, `OFFICIAL_CONFIG_DIR_NAME` gate first-time setup to the official pi
    distribution. The package name is still `@earendil-works/pi-coding-agent`, so setup
    still runs today. **Do not change these now**; add a code comment noting they must be
    revisited when the package name changes. If first-time setup stops triggering after the
    `piConfig.name` change, this is why — adjust the check to also accept `lunr`.

### Verify Phase 1

- `npm run build` passes.
- `npx lunr --help` shows `lunr` in usage/examples, no `pi` in the visible text.
- `npx lunr --version` still prints `0.80.10`.
- Run `npx lunr` interactively: terminal title starts with `lunr`, no "pi" in the startup
  header or trust prompt.

---

## Phase 2 — Custom boot screen

### Source art

`boot-ascii.md` in the repo root: 25 lines of braille/Unicode moon art, ~53 columns wide,
padded with U+2800 braille blanks. It is raw art, no markdown fences.

### Current boot screen (what gets replaced)

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `init()`, lines 717-747:
when `verbose || !quietStartup`, the header is a single `ExpandableText` showing
`logo + keybinding hints + onboarding`. The `ExpandableText` private class is at lines 72-90.
The header is added via `headerContainer` at ~line 750.

There is **no** side-by-side layout primitive in `packages/tui` (only vertical `Container`,
`Box`, `Text`, `Spacer`). The boot screen must implement its own `render(width)`.

### Changes

1. **New file `packages/coding-agent/src/modes/interactive/components/boot-ascii.ts`**:
   export `MOON_ASCII: string[]` — the 25 art lines from `boot-ascii.md`, one array entry per
   line, padding preserved. Generate this mechanically from the md file (do not retype the
   art). Embedding as TS avoids touching the `copy-assets` build step.

2. **New file `packages/coding-agent/src/modes/interactive/components/boot-screen.ts`**:
   a `Component` (extend the base used by `Text`/`Container` in `packages/tui`) implementing
   `render(width: number): string[]`:
   - Left column: `MOON_ASCII` lines, styled `theme.fg("accent", ...)`.
   - Right column: detail rows, label in `theme.fg("dim", ...)` + value in
     `theme.fg("text", ...)`. Rows:
     - `lunr` + version in bold accent (from `VERSION` in `config.ts`)
     - `model:` `this.session.model?.id` (fallback "none"), provider if cheap to get
     - `directory:` `sessionManager.getCwd()`
     - `session:` `sessionManager.getSessionName() ?? sessionManager.getSessionId()`
     - `config:` `getAgentDir()` from `config.ts`
     - `theme:` current theme name (will be `moon`)
   - Layout: art block width = max art line width (measure with the same string-width util
     the TUI uses; braille chars are width 1). Gap of 4 spaces. Details start at
     `artWidth + 4`. Truncate detail values to the remaining width.
   - **Narrow fallback**: if `width < artWidth + 24`, render details only (skip art). Never
     wrap art lines.
   - Below the two columns, keep one compact hint line and the reworded onboarding line from
     Phase 1 item 2, both `theme.fg("dim", ...)`:
     `esc interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+t more`
     (use the existing `keyHint`/`keyText` helpers at interactive-mode.ts:717-745 instead of
     hardcoding keys).

3. **`interactive-mode.ts` init()**: replace the `ExpandableText` header with the new
   `BootScreenComponent` inside the same `verbose || !quietStartup` gate. Keep the quiet
   path (empty `Text`) unchanged. Wire the component's data needs from what `init()` already
   has: `this.version`, `this.session`, `this.sessionManager`.
   - Keep the expanded/compact toggle behavior only if it comes free; it is acceptable to
     drop the `ExpandableText` expansion for the boot screen and always show the compact
     hint line. If `ExpandableText` becomes unused, remove the private class.

### Verify Phase 2

- `npm run build` passes.
- `npx lunr` in a wide terminal: art left, details right, correct values.
- Resize narrow (< ~80 cols) and restart: details-only fallback, no mangled art.
- `npx lunr --quiet` (or quiet startup setting): no boot screen.
- Windows Terminal + a Nerd-Font-less console: art renders (braille is in Consolas/Cascadia;
  if it doesn't render on the test machine, note it in AGENTS.md, don't redesign the art).

---

## Phase 3 — Monochrome `moon` theme (default, only built-in)

### New theme file

Create `packages/coding-agent/src/modes/interactive/theme/moon.json`. Palette rules:
monochrome white on black. Grays and white do all the work. Green/red/yellow only where a
color carries meaning the user must not miss: success/error/warning states and diff
added/removed. All 51 required color tokens must be present (schema:
`theme-schema.json`).

Use this exact palette:

```json
{
  "$schema": "./theme-schema.json",
  "name": "moon",
  "vars": {
    "white": "#e8e8e8",
    "brightWhite": "#ffffff",
    "lightGray": "#b0b0b0",
    "gray": "#808080",
    "dimGray": "#666666",
    "darkGray": "#505050",
    "darkerGray": "#303030",
    "nearBlack": "#1a1a1a",
    "green": "#5faf5f",
    "red": "#cc5555",
    "yellow": "#d7af00"
  },
  "colors": {
    "accent": "brightWhite",
    "border": "darkGray",
    "borderAccent": "white",
    "borderMuted": "darkerGray",
    "success": "green",
    "error": "red",
    "warning": "yellow",
    "muted": "gray",
    "dim": "dimGray",
    "text": "",
    "thinkingText": "gray",
    "selectedBg": "darkerGray",
    "userMessageBg": "nearBlack",
    "userMessageText": "white",
    "customMessageBg": "nearBlack",
    "customMessageText": "lightGray",
    "customMessageLabel": "gray",
    "toolPendingBg": "nearBlack",
    "toolSuccessBg": "nearBlack",
    "toolErrorBg": "nearBlack",
    "toolTitle": "lightGray",
    "toolOutput": "gray",
    "mdHeading": "brightWhite",
    "mdLink": "white",
    "mdLinkUrl": "dimGray",
    "mdCode": "white",
    "mdCodeBlock": "lightGray",
    "mdCodeBlockBorder": "darkGray",
    "mdQuote": "gray",
    "mdQuoteBorder": "darkGray",
    "mdHr": "darkGray",
    "mdListBullet": "lightGray",
    "toolDiffAdded": "green",
    "toolDiffRemoved": "red",
    "toolDiffContext": "gray",
    "syntaxComment": "dimGray",
    "syntaxKeyword": "brightWhite",
    "syntaxFunction": "white",
    "syntaxVariable": "lightGray",
    "syntaxString": "lightGray",
    "syntaxNumber": "white",
    "syntaxType": "white",
    "syntaxOperator": "gray",
    "syntaxPunctuation": "gray",
    "thinkingOff": "darkGray",
    "thinkingMinimal": "dimGray",
    "thinkingLow": "gray",
    "thinkingMedium": "lightGray",
    "thinkingHigh": "white",
    "thinkingXhigh": "brightWhite",
    "thinkingMax": "brightWhite",
    "bashMode": "white"
  },
  "export": {
    "pageBg": "#000000",
    "cardBg": "#0a0a0a",
    "infoBg": "#1a1a1a"
  }
}
```

Rationale to keep with the file: tool success/failure is conveyed by `success`/`error`
colors on the tool title and status icon, so the tool box backgrounds stay `nearBlack` for
all states. Syntax highlighting is grayscale; strings vs keywords differ by shade.

### Wire moon in as the only built-in

`theme.ts` (all line numbers verified):
- **`getBuiltinThemes()` (440-451)**: read `moon.json` only; return `{ moon: ... }`.
- **`getDefaultTheme()` (791-797)**: return `"moon"` unconditionally.
  `detectTerminalBackgroundFromEnv()` becomes unused for default selection; leave the
  function (settings auto-pairs may still reference it) but it no longer picks the default.
- **`initTheme()` fallback (834-849)** and **`setTheme()` fallback (850-872)**: change
  fallback `"dark"` → `"moon"` in both, including `currentThemeName = "dark"` assignments.
- **Validation error text (~540-555)**: "See the built-in themes (dark.json, light.json)"
  → "(moon.json)".

`theme-controller.ts`:
- **`applyThemeName` (~92-94)**: fallback `"dark"` → `"moon"`.

`settings-selector.ts`:
- **`preferredTheme` fallback (~257)** and **`defaultAutomaticThemes` (~295)**: `"dark"` →
  `"moon"`.

`first-time-setup.ts`:
- **`THEME_OPTIONS` (20-21)**: replace the dark/light pair with a single
  `{ value: "moon", label: "Moon" }`. If the picker UI breaks with one option, remove the
  theme step and hardcode the setting write to `"moon"`. Either is acceptable; note which
  was chosen in AGENTS.md.

### Delete the old themes

Delete `dark.json` and `light.json` from
`packages/coding-agent/src/modes/interactive/theme/`. Check the `copy-assets` build step in
`packages/coding-agent/package.json` for hardcoded references to them and update it.

Custom user themes (`~/.lunr/agent/themes/*.json`, `--theme <path>`) keep working — that
mechanism is untouched. Only the built-in set changes. If the user has `"theme": "dark"` in
`~/.lunr/agent/settings.json`, the fallback chain now lands on `moon`; that is the intended
migration. Note it in AGENTS.md.

### Fix tests

~27 test files call `initTheme("dark")`, read `dark.json` as a fixture, or assert on
`"dark"`/`"light"`. Mechanical replacements:
- `initTheme("dark")` → `initTheme("moon")`; `initTheme(undefined, false)` stays (default is
  now moon).
- Tests reading `src/modes/interactive/theme/dark.json` as a fixture
  (`max-thinking.test.ts`, `resource-loader.test.ts`, `theme-export.test.ts`,
  `theme-picker.test.ts`, `2791-fswatch-error-crash.test.ts`) → read `moon.json`.
- `interactive-mode-status.test.ts` tests `setTheme("light")` → switch to a temp custom
  theme file or assert on `moon`; pick the smaller diff.
- `theme-detection.test.ts` asserts `getThemeByName("dark")` → `"moon"`; review its
  COLORFGBG expectations since detection no longer picks the default.
- `first-time-setup*.test.ts` — update for the single-option picker.
- `args.test.ts:258-259` uses `--theme ./dark.json --theme ./light.json` as path strings
  only; harmless, but rename to avoid confusion if the files are gone and the test does fs
  operations.

Full affected list (from recon): `test/assistant-message.test.ts`,
`test/bash-execution-width.test.ts`, `test/edit-tool-no-full-redraw.test.ts`,
`test/footer-width.test.ts`, `test/interactive-mode-status.test.ts`,
`test/max-thinking.test.ts`, `test/oauth-selector.test.ts`, `test/resource-loader.test.ts`,
`test/session-info-modified-timestamp.test.ts`, `test/session-selector-path-delete.test.ts`,
`test/session-selector-rename.test.ts`, `test/status-indicator.test.ts`,
`test/syntax-highlight.test.ts`, `test/theme-detection.test.ts`, `test/theme-export.test.ts`,
`test/theme-picker.test.ts`, `test/tool-execution-component.test.ts`,
`test/tree-selector.test.ts`, `test/trust-selector.test.ts`, `test/user-message.test.ts`,
`test/suite/regressions/2791-fswatch-error-crash.test.ts`,
`test/suite/regressions/3217-scoped-model-order.test.ts`,
`test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts`,
`test/suite/regressions/5433-extension-oauth-prompt-input.test.ts`,
`test/suite/regressions/5596-missing-theme-export.test.ts`,
`test/suite/regressions/5943-session-start-notify.test.ts`.

---

## Final verification (all phases)

1. `npm run build` — clean.
2. `npx biome check packages/` — clean (boot-ascii.ts will contain long unicode strings; if
   biome complains about the generated file, add it to the biome excludes like
   `*.generated.ts`, don't hand-format the art).
3. `npm test` — compare against the recorded Windows baseline (tui 12 failed, ai 28 failed,
   coding-agent 34 failed). Theme-touching tests must pass; no *new* failures beyond the
   known Windows-environment categories (symlink EPERM, path separators, network, ESM
   quirks).
4. Manual smoke:
   - `npx lunr --help` → all `lunr`.
   - `npx lunr` → boot screen: moon art left, details right (version 0.80.10, correct
     model, cwd, session, `~/.lunr` config path), monochrome UI everywhere.
   - `/settings` → theme list shows only `moon`.
   - Fresh `~/.lunr` (move it aside temporarily) → first-time setup runs, offers moon,
     writes `"theme": "moon"`.
5. Update `AGENTS.md` Current State: what changed, build/test results, the deferred items
   (pi.dev URLs, scope renames, earendil announcement disabled, theme migration note).

## Definition of done

- Four commits on `feat/lunr-basics`: branding, boot screen, moon theme, test fixes
  (test fixes may fold into the theme commit).
- `npx lunr` boots into the art+detail screen in monochrome with zero visible "pi" strings.
- Build, biome, and tests pass per the criteria above.
- `AGENTS.md` Current State updated.
