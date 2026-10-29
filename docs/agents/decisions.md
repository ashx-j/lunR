# Decisions and deferred work

Read before reversing a past choice or picking up postponed work. Append new decisions at the top of the list with a date and a one-line why.

## Decisions

- 2026-10-29: the agent's `web_search` opens the curator only in the terminal app, because RPC and gateway sessions also report a UI, so every search started a local browser page nobody could see and waited up to 20 seconds for it.
- 2026-10-29: move `interactive-startup.md` and `model-catalog.md` from the package docs to `docs/agents/`, because they are maintainer notes (benchmarks, generator internals) that shipped in the npm docs.
- 2026-10-29: keep `@earendil-works/pi-*` imports in the repo's example extensions, because the root tsconfig paths and vitest resolve those names and the publish step rewrites them to `@ashx-j/*`; the docs say the loader accepts both.
- 2026-10-29: remove the issue and PR auto-close gates, because their approved list held pi's contributors, their message linked a CONTRIBUTING.md that doesn't exist, and the Questions link went to pi's Discord.
- 2026-10-29: the published packages name ashx-j as author and the pi screenshots are gone from the docs, because npm showed Mario Zechner as the author of `@ashx-j/lunr` and its first image was pi; pi's credit stays in the README and THIRD_PARTY_NOTICES.
- 2026-10-25: CI and the publish workflow install bun for the script tests instead of dropping `build-standalone.test.mjs`, because that test checks the standalone bundle keeps Chromium, HTML and PDF extraction, which the release binaries rely on.
- 2026-10-25: pin Claude Code 2.1.310 and read only its picker at setup, taking non-`[1m]` windows from the catalog, because 2.1.263's picker has no 5.5 models and 2.1.310's `set_model`/`get_context_usage` contact Anthropic, which setup must not do.
- 2026-10-25: drop a scoped model when its provider has no credential left (at logout and at startup), but keep bare ids, globs, unregistered providers and project settings, because a stale `provider/model` only printed a warning on every start while the others may still match.
- 2026-10-25: build catalog rows from models.dev data for every shipped provider and keep model knowledge in one rules file, because hand-kept id lists in the 2,600-line generator silently dropped new models (MiniMax-M3.1-Flash) and gave new families wrong settings (Copilot routed Claude Fable and GPT-6 to chat completions; Claude Opus 5 had no adaptive thinking).
- 2026-10-25: ship every models.dev provider with an OpenAI- or Anthropic-compatible endpoint and an API key variable as a generic provider (167 today), because models on providers nobody had written code for were unreachable; their rows stay out of the CLI bundle so the package and startup cache keep their size.
- 2026-10-25: read every logged-in provider's own model list instead of eight, and resolve new ids with the generator's code plus a published facts file, because lab releases reached providers' lists hours or days before models.dev and lunR showed them only after both caught up.
- 2026-10-25: a new id with no known facts starts without thinking controls, because sending a reasoning parameter to a model that rejects it breaks every turn, while omitting it only uses the model's default.
- 2026-10-25: ship `facts.json` only in versioned publications, not the CLI bundle, because it is only needed for models newer than any bundle.
- 2026-10-25: quarantine a shrunk provider instead of the whole models.dev source, because one dropped provider lunR never ships froze every new model for seven weeks. A provider that vanishes is let go (removal or rename); a total drop over 25% still falls back as a whole.
- 2026-10-25: keep skipping models.dev `deprecated` rows for Together and Copilot only, because elsewhere "deprecated" often means superseded but still served (MiniMax-M2.7, GLM-5.2).
- 2026-10-25: the GPT-6 runtime overlay fills only thinking levels the catalog leaves open, so models.dev's effort "none" keeps "off" available.
- 2026-10-25: hide thinking levels a model does not list instead of mapping them to a neighbor, so every level in the picker sends a value the provider accepts.
- 2026-10-25: start direct OpenAI models at their base price tier's context window (272k) whenever models.dev lists a long-context tier, because requests above it bill at up to twice the rate; GPT-6 and the Pro models were the exceptions before.
- 2026-10-25: Claude Opus 5.5, Sonnet 5.5, Fable 5 and Mythos drop "off" through a catalog rule, because they reject disabled thinking and models.dev has no field for it.
- 2026-10-25: read models.dev `kimi-code-plan-global` when `kimi-for-coding` is missing but keep the api.kimi.com endpoint and skip `k3.1-*`, because the rename moved the listing to api.kimi.ai and K3.1 is untested there.
- 2026-10-21: remove the unused agent harness (about 6,000 lines) and keep `uuidv7`, because nothing outside the package used it and no upstream sync happened.
- 2026-10-21: scale compaction reserve and kept tokens to the window, because with a 16k window `shouldCompact` was true every turn and nothing was old enough to cut.
- 2026-10-21: a TUI cron owner hands the lease to the gateway when it skips due jobs, because only the gateway can deliver to chat platforms.
- 2026-10-21: keep `NPM_TOKEN` and add pre-publish checks and registry verification, because trusted publishing needs npm-side setup first.
- 2026-10-21: drop source maps, `exy.png` and catalog extras from the package, because nothing reads them at runtime and they doubled the tarball.
- 2026-10-21: read-only bash blocks any word bash expands and any path-qualified command word, because the classifier sees literal words while bash runs the expanded ones.
- 2026-10-21: `cron resume` retries an interrupted job through whichever process owns the lease, because a gateway-held lease left `cron run` with no process able to run it.
- 2026-10-21: an abort during tools ends the run with aborted results for unstarted calls, matching an abort during streaming, because queued calls ran with an aborted signal and a new request followed.
- 2026-10-20: cap the number of `@ts-nocheck` files with a limit that may only go down, so new unchecked files fail `npm run check` while the vendored backlog shrinks.
- 2026-10-20: help describes `--provider` as narrowing `--model`, not as having a default, because the code never falls back to a saved or built-in provider for that flag.
- 2026-10-20: group `/settings` into sections and move nine rarely changed rows into an Advanced submenu, because a flat 53-row list was hard to scan; descriptions and handlers stayed the same.
- 2026-10-20: Ctrl+D needs two presses within 1.5s on an empty editor, because Ctrl+D also deletes forward and one press on an empty line quit lunR.
- 2026-10-20: key builtin slash dispatch by command name instead of an ordered if-chain, because every old condition was an exact name or `name ` prefix, so order never mattered and a Map lets a test check it against the builtin table.
- 2026-10-20: hide aliases and merged commands instead of deleting them, so typed habits and saved prompts keep working while the `/` list shrinks; delete the hidden merged names after one release.
- 2026-10-20: route `/chain` on the first token's inline config before any name lookup, because every valid task chain carries `[tier=…]`/`[model=…]` or a `(` group and must never be rerouted by a workflow or template that shares a name.
- 2026-10-20: recognize slash commands from dispatch sources instead of the autocomplete list, so commands hidden from the picker still run instead of being reported unknown.
- 2026-10-20: gate onboarding on saved credentials plus no usable model, because environment keys and local providers can run without a saved login and should not see it every launch.
- 2026-10-20: move /login into `login-flow.ts` behind a host object instead of public InteractiveMode members, so onboarding can reuse it without growing the 8k-line file or the exported class API.
- 2026-10-18: auto is reviewed and "no questions" is a separate session flag, so goals and subagents keep working unattended under yolo without paying for reviews.
- 2026-10-18: default reviewers come only from providers whose own agents ship one (Claude Code, Codex, Grok Build, Qwen Code); other providers must pick a model, because choosing a safety reviewer is the user's call.
- 2026-10-18: remove `/share` and the subagent `share` option instead of hosting a viewer, because both sent sessions to pi's site; keep accepting the old descriptor field so saved runs resume.
- 2026-10-18: read a saved `shadow-git` rollback capture as `copies`, because that is what the menu promised and it deletes fewer files than the hybrid behavior it had.
- 2026-10-18: gate notices on terminal focus reports, not run length, so watched runs stay quiet and abandoned short runs still ping.
- 2026-10-18: enable type checking on pi-subagents files that already pass before fixing errors, so new mistakes there fail the build without touching vendored behavior.
- 2026-10-17: derive Claude subscription routes from Claude Code's picker, skipping usage-credit variants, because a hardcoded route table goes stale and had routed Opus 5 to credit billing.
- 2026-10-17: let Claude Code send subscription requests straight to Anthropic and read its `stream_event` output, because Anthropic's terms bar developers from intermediating Claude.ai session tokens while allowing sign-in to unmodified Claude Code.
- 2026-10-17: after `/login`, fall back to the provider's first offered model in Claude Code picker order, so plans without the hardcoded default still get Claude Code's default.
- 2026-10-17: narrow app model lists in RPC `get_available_models` behind an opt-in setting so ACP and the RPC provider share one rule and `/model` stays unchanged.
- 2026-10-16: let ACP clients change modes mid-turn and re-check read-only on open approvals, because the spec allows it and gates read the mode per call.
- 2026-10-15: keep Claude subscriptions on a lunR-managed pinned Claude Code because Anthropic's terms forbid third-party Claude.ai login and impersonation, and setup then needs no Python or matching local install.
- 2026-10-15: inject Claude Code as the Anthropic SDK `fetch` so subscription turns reuse the Messages request builder and stream parser.
- 2026-10-11: adapt pi-acp around one native RPC worker per ACP session so T3 reuses lunR's tools and journals without changing saved defaults; apply ACP settings as in-memory overrides.
- 2026-10-11: send ACP status and child notices as activity because T3 concatenates assistant chunks; label models by name and add the provider only on duplicates.
- 2026-10-11: ship pi attribution in `THIRD_PARTY_NOTICES` so the main license identifies lunR while distributions keep the upstream notice.
- 2026-10-11: change fallback defaults without a migration so explicit saved choices stay authoritative.
- 2026-10-06: share receipt-backed delivery between PR waits and async notifications so interruption and restart cannot lose or duplicate feedback.
- 2026-10-06: keep PR-watch duration and cancellation under user control with head-only resets, so agents cannot silently extend monitoring; leave readiness judgments to the agent.
- 2026-10-04: count durable request identities across conversation and auxiliary calls, and prefer provider-reported spend, so navigation and replay cannot erase or duplicate usage.
- 2026-10-04: integrate reviewed PRs through merge ancestry in one integration or release PR and require fresh green CI, so overlapping files resolve once and baseline failures do not ship.
- 2026-10-03: isolate test profiles with an allowlisted environment instead of moving saved credentials.
- 2026-09-27: production approval of the pinned CuaDriver needs explicit owner confirmation, separate from byte integrity and runtime acceptance.
- 2026-09-26: keep uncertain native computer outcomes with one recovery image, because an error after delivered input must not invite blind replay; accept effects only from fresh post-action images.
- 2026-09-13: bound screenshot payloads and keep provider history until targeted retention can be measured against prompt-cache disruption.
- 2026-09-26: default substantive delegation to the standard tier and require a specific reasoning difficulty for heavy, because broad labels encouraged over-selection.
- 2026-09-26: use one gateway authorization check for messages and commands so pairing grants usable access without a second owner approval.
- 2026-09-26: reuse the gateway outbox for final answers and follow-ups and keep bounded failed batches instead of retrying forever or dropping text.
- 2026-09-25: frame oversized child JSON events instead of raising the stdout line limit, so image results survive while transport stays bounded.
- 2026-09-24: replace manual and plan with yolo, auto and read-only, and fail closed on unclassified tools in read-only, because proxy and direct MCP calls can write.
- 2026-09-24: keep parent-child messaging and autonomous delegation as independent default-on switches, because direct-work mode should still allow requested children.
- 2026-09-21: put fresh-versus-resume and gateway management in the default prompt because both must be right before the first tool call.
- 2026-09-21: treat Enter during `subagent_wait` as a run-scoped graceful handoff so background work survives.
- 2026-09-13: keep intercom and its relay, fixing Windows stderr ownership instead of replacing the communication system.
- 2026-09-12: gate question wakeups on answered state so cancellation cannot undo a double-Escape stop.
- 2026-09-12: children choose exactly one of tier or model so user-named models work without tier mode.
- 2026-09-12: remove agent settings tools and `watchdog.configure` so settings stay in `/settings`.
- 2026-09-08: Codex uses each route's `context_window` as its compaction budget and checks it between tool turns; `max_context_window` never becomes the default.
- 2026-09-08: skip automatic compile-cache for the Node bundle because reuse increased measured startup latency.
- 2026-09-05: paint the production TUI before runtime imports and bind the existing editor in place, so startup does not wait on hydration or lose drafts.
- 2026-09-05: CI and the root build use offline package builds so validation cannot drift the generated catalog.
- 2026-09-05: pin coding-agent external dependencies and map workspace-local rows into the installer lock so published installs resolve reviewed versions.
- 2026-09-05: use package builds for production type safety and Vitest for tests; the root no-emit pass mixed incompatible fixture types.
- 2026-08-30: persist `modelSelection` at spawn because resolved `spec.model` cannot distinguish tier routing from an explicit model.
- 2026-08-29: prompt-driven subagents replace named types with task+description+full|read-only; private `childId` routes because display labels misaddress children.
- 2026-08-29: separate user-owned global instructions from agent-managed memory facts; the memory toggle hides injection/tools without deleting data.
- 2026-08-29: Fast mode persists only for `openai-codex`; paid `openai` API models never activate it.
- 2026-08-29: `/usage` renders all stored adapter plans; the footer stays current-provider-only.
- 2026-08-29: remove `/research`; generic subagents and web tools cover research.
- 2026-08-28: watchdog repo-edit fingerprints are lazy and enable-gated so a default-off reviewer cannot block prompt readiness.
- 2026-08-24: same-turn SINGLE `subagent` calls count toward the large-launch gate; sequential work stays `chain`.
- 2026-08-23: grok-4.5+ uses Responses via `parseXaiGrok4Minor >= 5`, not a frozen id; the overlay replaces Completions compat.
- 2026-08-20: stamp Grok 4.6+ xhigh in `mergeCatalogLayers` and rebind the session model after `/refresh`, because the session holds a stale Model object.
- 2026-08-18: cache smooth-streaming grapheme ends per content block, because a message WeakMap went stale when providers did `block.text += delta`.
- 2026-08-17: time-to-type = `ui.start()` + light rebind; gate prompt and `/new`, not the editor, because awaiting deferred attach and auto-installs hung startup.
- 2026-08-16: first paint is cache-only because live `refresh()`, localhost probes and uncapped OAuth hung boot after idle.
- 2026-08-16: model-tiers toggle uses `pi.registerTool`, not `pi.runtime` (not on ExtensionAPI); refresher errors are not fatal.
- 2026-08-16: public install is `npm i -g @ashx-j/lunr` with publish-time rewrite of package.json **and** dist imports. Do not publish `@earendil-works/*`.
- 2026-08-14: sticky chatbox in `packages/tui`; xAI `/usage` = weekly SuperGrok pool; usage bars use 70/90.
- 2026-08-13: todos = extension, full-replace; plan approval = `present_plan`; custom provider writes models.json then login.
- 2026-08-08: `thinkingCollapse` layered on `hideThinkingBlock`; `/exit` = `/quit`.
- 2026-08-06: subscriptions sibling file; auth.json = active key; `autoManageSubscriptions` is manual switch only.
- 2026-08-03: do not add boot art. `qwen-cloud` ≠ token-plan. `/refresh` is the only refresh command.
- 2026-07-28: cron in TUI + daemon; Discord discord.js; Telegram long-poll; authz fail-closed.
- 2026-07-26: extension-absorption rolled back — baked-in extensions + bridges only. No “done” without live `npx lunr` + one message.
- 2026-07-22 / 08-15: no pi.dev catalog. `/refresh` = local `/models` + our GitHub `catalog/`.
- 2026-07-18: `.lunr/` split; keep `pi-*` scopes + `PI_CODING_AGENT_*`.

## Deferred

- Gateway cold first slash after daemon start can hang minutes; local scripted-provider first-use flow passes but does not establish a cold-start latency bound.
- Live verify: Ollama/LM Studio, zai Bearer, multi-key rotation, catalog `/refresh` + `/model` after stability merge.
- Claude subscriptions: live runs used one signed-in account; macOS and ARM remain unqualified.
- Computer use: held modifier/button release, Mac/ARM hardware, provider-driven use, and live Windows hover/taskbar recovery remain unverified. Smooth cursor animation needs a scope decision.
- Scope rename; `PI_CODING_AGENT*` rename.
- Rollback: shadow-git capture (option removed until built), gateway rollback (B7), orphan GC, symlink escape. Orchestrator timeouts from closed PR #41 remain unshipped.
- Cron: script/`no_agent` jobs; more gateway platforms; process-tree for `nohup` grandchildren.
- Package size: maps, `exy.png` and catalog extras are cut (5.41 MB packed). The 211 MB of other-platform optional packages npm installs remain; see `docs/package-size-report.md`.
- Planned mascot, a cat (2.A): fits the kitty spinners `₍^. .^₎⟆` / `(ㅅ´ ˘ `)`. Minimal two lines, not yet wired.
  ```
     /\_/\
    ( ˃ᴗ˂ )
  ```
