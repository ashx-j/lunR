# lunR UX/Providers plan — progress log

## 2026-07-19 — Phase 1: Remove MattDevy + narumiruna extension collections (keep pi-goal)

### What changed
- Deleted 18 of 19 collection directories under `packages/coding-agent/src/builtin-extensions/`:
  - MattDevy (6): pi-blueprint, pi-code-review, pi-compass, pi-continuous-learning, pi-red-green, pi-simplify
  - narumiruna (12): pi-btw, pi-caffeinate, pi-chrome-devtools, pi-codex-accounts, pi-codex-usage, pi-firecrawl, pi-github-pr, pi-google-genai, pi-langfuse, pi-plan-mode, pi-retry, pi-sync
- **Kept** `narumiruna-pi-goal` (plan 2's /goal indicator) and all non-collection extensions untouched.
- `packages/coding-agent/src/builtin-extensions/index.ts`: removed the 18 imports and their `ext(...)` registrations; `narumirunaGoal` import/registration kept.
- `packages/coding-agent/package.json`: removed the 5 langfuse-only deps (`@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node`). All other bake-in deps stay. `npm install` run from repo root to sync `package-lock.json`.
- `copy-assets` checked: it only references `context-mode` and `pi-subagents` asset paths — nothing inside deleted dirs, no changes needed.
- Reference sweep: greps for `mattdevy|narumiruna|langfuse|opentelemetry` across `packages/coding-agent/src` and `test` now hit only the kept pi-goal import/registration in `index.ts`. `main.ts` and the startup Extensions filter (interactive-mode.ts:1476) are name-agnostic — no hardcoded lists to fix.
- `extension-repos/` reference clones NOT deleted (kept as study material; narumiruna clone needed for Phase 12 plan-mode reference).

### Side effects
- Commands gone: `/codex-status`, `/codex-login`, `/codex-account`, `/codex-logout`, `/btw`, `/plan` (until Phase 12 re-adds plan mode natively), plus the deleted extensions' other commands (code-review, simplify, compass, etc.).
- Caffeinate acquire/release notification noise gone by deletion.
- The langfuse `getAgentDir()` fix and the MattDevy hardcoded `~/.pi` known-issues are moot (deleted code).

### Verification
- Build: `packages/agent` → `packages/coding-agent` → `packages/orchestrator` all compile clean (exit 0). Did not rebuild `tui`/`ai` — existing dist used, avoiding the known ai live-catalog drift issue.
- `npx biome check packages/` — clean (800 files).
- Tests: coding-agent vitest — Test Files 88 failed | 85 passed | 2 skipped (175); Tests 56 failed | 982 passed | 21 skipped (1059). Compare baseline (58 failed | 980 passed | 21 skipped; 89 load-failures): actually 2 fewer failures, all remaining are the known pre-existing categories (load-failure circular import, symlink EPERM, path separators, network-dependent, Windows quirks). No NEW failures.
- `npx lunr --version` — 0.80.10. coding-agent dist clean-rebuilt (`npm run clean && npm run build`) so stale compiled output from deleted extensions is gone; dist/builtin-extensions/ now contains only kept extensions.

### Deviations from plan
- None in file scope. Interactive runtime verification (`/goal` end-to-end, `/` autocomplete, caffeinate-free startup) not performed in this session — static/build-level verification only.
