# Interactive startup plan

Paint the normal lunR interface before importing the agent runtime. Models,
resources, session restoration, extensions, and maintenance may take longer;
they must not determine when the user first sees the chatbox.

PR #41 starts a generic editor with a separate startup message, then changes the
layout and editor after hydration. Its first-frame marker also accepts terminal
setup writes. Keep its useful early routing and startup-dialog work, but replace
the temporary presentation and measure actual rendered content.

1. Start a persistent view using the existing themed ChatboxEditor,
   BootScreenComponent, and stats renderer. Read only local display preferences.
   Reuse the terminal and editor when InteractiveMode attaches. Unknown runtime
   data fills in later; no second startup screen or editor reset.
2. Begin runtime imports after a complete TUI frame has been written. Keep
   session selection and trust dialogs on that terminal. Preserve drafts,
   cursor position, and pasted images while initialization proceeds.
3. Hold submissions until session and extension initialization completes, then
   dispatch through the normal command/message handler. Keep failures visible
   and allow exit while loading. Defer session retention and other maintenance.
4. Verify real frame content without a runtime, editor identity across binding,
   delayed/failing initialization, command routing, and noninteractive launches.
   Benchmark first content frame separately from runtime and feature readiness,
   using isolated settings and both cold and warm compile caches.

This PR targets startup only. The permission, rollback, orchestrator, and release
changes in #41 remain separate. Custom extension themes/editors become available
when their resources load; the builtin moon interface is available immediately.

## Validation

The Node CLI keeps one terminal and one moon editor through attachment. Enter
during loading holds the current draft. Edits continue to change that draft;
Escape cancels the pending submission. Commands run through the normal handler
after features are ready. A failed feature load preserves the draft and reports
the error instead of submitting it.

The shipped moon theme avoids loading the schema compiler and highlighter before
paint. Custom theme validation and syntax highlighting use the same implementations
on first use. Footer git discovery and diffs run asynchronously.

After the offline builds, run:

```sh
node scripts/check-interactive-first-paint.mjs
node scripts/profile-coding-agent-node.mjs --mode tui --skip-build --isolated-agent-dir --runs 3
```

The first command exercises the built CLI with runtime loading stalled or failed.
It verifies the real chatbox appears before hydration, accepts edits while
waiting, and restores the terminal on exit. The Vitest integration also checks
editor identity, cursor position, images, dialogs, and delayed command dispatch.

On Windows with Node 24.15.0 and moon, three fresh compile-cache runs wrote the
first complete frame in 94.8–95.3ms. Three warm runs measured 96.6–99.1ms. Feature
readiness came at 2.01–2.43s. Milestones include Node entry-module loading.
Terminal compositor latency and compiled Bun binaries were not measured.
