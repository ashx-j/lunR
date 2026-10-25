# Permissions, auto review and memory

Read before changing permission modes, the auto reviewer, protected files, global instructions or memory.

## Modes

- `yolo | auto | read-only` (`PERMISSION_MODES`, default yolo); Shift+Tab cycles that order and the TUI shows `read`. Fail-closed without a handler. Bash is a heuristic, not an OS sandbox.
- Read-only bash is fail-closed on anything bash rewrites before running: `$` expansions (also inside double quotes), `$'…'`, brace lists, a command word with a directory outside `/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, config-redirect env (`HOME`, `PATH`, `XDG_*`, `RIPGREP_CONFIG_PATH`, ...) and git `-C`/`--git-dir`/`--work-tree`/`--bare`. MCP direct tools whose name matches a trusted name (`READ_ONLY_TOOLS`, `REVIEW_FREE_TOOLS`, `browser`, `code_rewrite`, `subagent`) are skipped with a warning. For option-sensitive commands (sed, sort, file, find, rg, git) a word blocks when the literal text before its first unquoted glob is empty or only dashes (`*`, `-*`, `""*`, `\-*`). `yarn`, `file -C` and `less -k`/`--lesskey-*`/`-o` also block.
- Read-only = `gateToolCall` + `readOnlyModeBlockReason` + `READ_ONLY_MODE_ADDENDUM`. It blocks unclassified extension tools, including direct MCP tools; the `mcp` proxy allows status, search, describe and ui-messages. Saved `manual`/`plan` values read as yolo/read-only without rewriting. Gateway switches to a saved writable mode pause in read-only until confirmed. Read-only does not revoke running full-access children.
- Auto = yolo plus the AgentSession review step (`core/auto-review.ts`).
- "No questions" (`AUTONOMOUS_ADDENDUM`) is a per-session flag set by `/goal`, children and ACP Autonomous, not a mode.

## Auto review

- Auto review runs in `AgentSession` after `gateToolCall`, not in `permissions.ts`, because it needs the model runtime, messages and session usage. Keep `needsAutoReview` derived from `readOnlyModeBlock` so new tools default to reviewed. It also reviews `web_fetch`/`fetch_content`, browser `navigate`/`tabs`, env-prefixed bash and hidden or outside paths (resolved with `resolveToCwd` + `canonicalizeTargetPath`).
- The reviewer never sees tool results. It clips long actions head-and-tail with a marker and lists `path`/`command`/`url` first. AGENTS.md and extension-sent user messages (tracked in a WeakSet by identity, lost after reload) are labelled as context that can't authorize anything. An aborted review returns early and never counts toward the ask-the-user limit. `autoReviewModel` is read from global settings only.
- ACP workers call `setAutoReviewEnabled(false)` and tie autonomy to ACP's `auto` (Autonomous), because the ACP client approves every tool itself. `-p` and gateway cron sessions in auto also set autonomy, preserving what a saved auto default meant before.

## Global instructions and memory

- Global behavior is optional `~/.lunr/agent/agents/AGENTS.md`: never auto-create it, add an in-app editor, or let model file tools modify it. A leftover `~/.lunr/agent/AGENTS.md` migrates there when the new path is empty. Per-model files are `~/.lunr/agent/agents/<model>/AGENTS.md` behind `/settings` Model instructions. Context breakdown labels it `Global AGENTS.md`. `behavior.md` is inert.
- Memory (`~/.lunr/simple-memory/memory.md`) is durable facts only; the toggle removes injection/tools but keeps the file.
- `core/protected-targets.ts` blocks direct file-tool writes to global instructions, memory, settings.json, `pr-watches/` and `install-features.json`.
