Reviewed the clean worktree at `b57c148`. I made no edits or builds.

### Findings

- **Medium, broken image-paste test coverage.** `packages/coding-agent/test/image-paste-markers.test.ts:121,152` invokes a prototype-based `InteractiveMode` mock without `runtimeHost`. Both submit tests crash at `src/modes/interactive/interactive-mode.ts:3049` before checking chip submission or `/paste-image`. This does **not** establish a production paste failure.
- **Low, stale migration links.** `packages/coding-agent/src/migrations.ts:13-16,313-314` prints upstream `pi-mono` documentation links when deprecated extension directories trigger a warning, rather than lunR documentation.
- **Existing fixture failures, not confirmed runtime regressions.** Project-settings tests still create `.pi/settings.json`, for example `test/settings-manager.test.ts:19,284,300-392,404,533`, while `src/core/settings-manager.ts:288` uses `.lunr`. The resource-list tests also retain old path and listing expectations. `test/footer-width.test.ts:85` expects `/` in a Windows-rendered path.

The selected TUI tests passed **390/390**. A clean focused coding-agent set passed **198/198**, covering streaming, thinking, clipboard mocks, copyable blocks, model labels, widgets, migration, editor actions and context labels. Broader runs found **21 failures with 246 passes** and **2 failures with 162 passes**, including the fixture problems above. Logs are under `C:/Users/ash/AppData/Local/Temp/lunr-ui-*-test.log`.

### PR disposition

- **Source-tested UI behavior:** #6, #7, #10–15, #18, #19, #22, #29, #32, #34, #35, #38, #52, #56, #58, #59, #68. Tests cover the relevant behavior or a focused subset, not every claim in each PR.
- **Partial source review; no compiled-current or live acceptance:** #8, #9, #17, #31, #36, #47, #54, #55, #57, #66.
- **Superseded in current UI:** #20’s behavior presets; #53’s rail removal and #60’s empty-chat context card, both reversed by #68.
- **Release, integration or documentation disposition only:** #21, #33, #37, #51, #67, #69, #70, #86, #87, #97, #98, #104, #105, #112–115. The checkout declares `0.2.24`; I did not verify an installed release.
- **Outside this UI assignment:** #1–5, #16, #23–28, #30’s child executor, #62–64, #72, and provider or executor portions of mixed PRs.

`pi` naming is separate from the UI findings. The `.pi` references in settings tests are stale fixtures; `@earendil-works/pi-*` imports are retained package names. The migration warning’s `pi-mono` links are user-visible.