# lunR

Custom CLI coding agent derived from pi. Builtin theme: `moon`. Has a TUI, baked-in features, cron, a Discord/Telegram gateway and ACP mode.

## Layout

lunR is the git root. `pi/`, `hermes-agent/`, `kimi-cli/` and `extension-repos/` are gitignored study material; never import from them.

```
packages/tui · packages/ai · packages/agent · packages/coding-agent (bin lunr → dist/cli.js) · packages/orchestrator
```

TypeScript ESM. Build order: tui → ai → agent → coding-agent → orchestrator. **Never `npm run build` in `packages/ai`** (catalog drift). **Never merge `archive/extension-absorption-DO-NOT-MERGE`.** **Never write `~/.pi/`.**

## Agent rules

- Read this file first, then the topic files below that match your task. Ask when ambiguous.
- Touch only the task. No drive-by rewrites; check existing deps before adding. Small commits that say why.
- Never commit secrets; never force-push shared branches; confirm destructive git. Branch + PR before merge.
- Public docs contain no local setup or secrets.
- When an agent-facing tool is added, removed, renamed, conditionally registered, or materially changes purpose, keep its description/schema and conditional result guidance accurate, update tool-coverage tests, and regenerate the system-prompt inventory/snapshot and first-request hashes when affected. Add always-injected base-prompt guidance only when the model needs it before its first tool call.
- After work, update the docs: Current State below, gotchas in the matching topic file, and a dated one-line-why entry in `docs/agents/decisions.md`. Delete stale entries. Committed detail lives in git log.

## Topic files

Read the ones that match your task. Each lists facts and gotchas that are not obvious from the code.

| File | Read when |
| --- | --- |
| [docs/agents/build-and-release.md](docs/agents/build-and-release.md) | building, running tests, checks, packaging, publishing |
| [docs/agents/architecture.md](docs/agents/architecture.md) | extensions, bridges, cron, rollback, pi naming, code conventions, prompt/tool changes |
| [docs/agents/tui.md](docs/agents/tui.md) | startup, rendering, input, mouse, slash commands, `/settings`, onboarding |
| [docs/agents/models-and-providers.md](docs/agents/models-and-providers.md) | model catalog, `/model`, login, xAI, OpenAI/Codex, OpenCode, Claude subscriptions |
| [docs/agents/subagents.md](docs/agents/subagents.md) | subagent launch, display, async runs, intercom, `/chain` |
| [docs/agents/permissions-and-memory.md](docs/agents/permissions-and-memory.md) | permission modes, auto review, protected files, global AGENTS.md, memory |
| [docs/agents/integrations.md](docs/agents/integrations.md) | gateway, ACP, PR watch, computer use |
| [docs/agents/testing.md](docs/agents/testing.md) | writing or debugging tests and fixtures, known flakes |
| [docs/agents/decisions.md](docs/agents/decisions.md) | before reversing a past choice; deferred work |

Feature docs that ship with the package live in `packages/coding-agent/docs/` (startup, model catalog, ACP, PR watch, computer use).

## Current state

- Last updated 2026-10-24. **v0.2.39** is published as `@ashx-j/lunr@0.2.39` (integration PR #221 merged PRs #211 to #220). Earlier releases and per-PR history: git log.
- 0.2.39 added the onboarding screen, `/help`, unknown-`/word` suggestions, `/settings` sections with an Advanced submenu, Ctrl+D twice to quit, hidden slash commands (63 visible at `/` with a clean profile) with `/off`…`/max` removed and `/websearch`, `/chain-workflows`, `/chain-prompts` merged into `/search` and `/chain`, `login-flow.ts`, `slash-dispatch.ts`, `lunr --help` Common options, the `@ts-nocheck` count check and `docs/package-size-report.md`.
- 0.2.38 removed `/share`, the subagent `share` option, the unbuilt `shadow-git` rollback mode, dead upstream code and two pi easter eggs. It added terminal notifications, `lunr doctor` and reviewed auto mode with "no questions" as its own session flag.
- 2026-10-25: catalog rows come from models.dev data for every shipped provider (thinking levels, prices, tiers, limits), with wrong facts in `packages/ai/src/catalog/rules.ts`. A shrunk models.dev provider is quarantined alone instead of freezing the source. The live catalog reaches users through the hourly `model-catalog` publish without a CLI release.
- 2026-10-25: live discovery reads every logged-in provider's model list (Anthropic and Google included) and resolves new ids with the generator's resolver and the published `facts.json`.
- Untracked locals on the owner's host may include `HANDOFF-*.md`, `LUNR_SYSTEM_INJECTION.md` and `.pi-subagents/`; `prompts/` is tracked.
