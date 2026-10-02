# Computer-use reliability and recovery plan

## Status and scope

Plan prepared 2026-09-26 after the Windows taskbar-shortcut report. The user then authorized implementation on a new branch with two heavy subagents, after the investigator finished.

Implemented wrapper changes are in `../lunR-computer-recovery`, branch `fix/computer-use-recovery`, commit `fa14743`, and [PR #125](https://github.com/ashx-j/lunR/pull/125). The PR targets `feat/native-computer-use`, the existing PR #77 branch, to keep its diff scoped. The two implementation children owned separate worktrees; their changes were combined and verified by the parent.

Validation passed: 128 focused tests across ten suites, all five offline package builds and the Node bundle, first-paint/first-turn checks, and a local scripted CLI turn verifying the initial and loaded tool schemas. The latter regenerated private inventories and prompt snapshots under the implementation worktree's `.artifacts/computer-recovery/`. Touched-file Biome with formatting disabled, relative-import, lock, and whitespace checks pass.

No native driver was launched, no desktop was operated, and no installed CLI or native binary was changed. Step 7's original native failure diagnosis and the real-desktop acceptance remain unverified. Publication and stable integration were not performed. The numbered sections below retain the implementation plan and its remaining acceptance requirements.

This replaces the earlier Spotify recovery plan in this file. That plan's pre-dispatch reporting, exact-token guidance, Unicode partial-typing handling, and decoded-pixel comparison have already reached the installed dev build. Preserve those fixes rather than implementing them again.

The inspected installation is `@ashx-j/lunr-dev@0.2.25-dev.13.1`. Its workflow, adapter, schemas, and extension source maps match `../lunR-pr77-dev-0.2.25` at `0dc7ebe`, apart from the expected published package-name rewrite. This identifies the inspected software, not the exact version of the user's earlier taskbar session. The native pin is CuaDriver 0.28.1 at `d8028a7943087ee258dc1b4d19dc12a7cd27669c`.

Implement in a new isolated branch based on the current PR #77 computer-use source. Verify the base against the dev integration before starting. The original checkout lacks this implementation and has unrelated changes. Keep stable lunR, the installed dev CLI, private screenshots, and release channels untouched unless separately authorized.

## Findings and confidence

| Report | What is established | Planned response |
| --- | --- | --- |
| Click reports failure but appears to work | The user observed this. A fake-driver reproduction confirms that a returned native error skips the recovery image and closes the workflow even after simulated input changes the screen. The actual native failure phase remains unproven. | Separate input delivery from verification, retain safe native reasons, and return one recovery image when safe. Never automatically repeat the click. |
| Launch returns unsuitable guidance | Confirmed in the installed workflow. Launch receives `Capture the exact target before input.` regardless of success or failure. This is post-launch guidance, not a schema requirement, but its placement makes that unclear. | Give launch-specific outcomes and discovery instructions. Do not add an observation token to launch. |
| Stale observation stops work | Confirmed. Validation errors close the workflow. `observation_unavailable` does not establish expiry. App discovery also discards a valid observation. | Keep recoverable validation errors inside the workflow and require a fresh image. Preserve observations across read-only discovery. |
| No useful failure reason | Confirmed reporting gap. Top-level native `message` is dropped, nested diagnostic fields are narrowly selected, and refused outcomes collapse into `refused_or_failed`. | Introduce bounded phase/reason codes without exposing raw native text or accessibility data. |
| Hard to identify taskbar icons | There is no hover tool. The reported red-icon mistake is not evidence of coordinate drift. | Add image-grounded hover if the native operation satisfies the required behavior. Prefer this to reintroducing accessibility-tree targeting. |
| Discord window requires PID lookup | Existing two-step design, not evidence of a capture failure. Query filters the selected app or window collection; it does not join app results to their windows. | Make window discovery explicit, then provide bounded named-app window enrichment. Preserve targeted off-primary capture. |

### Additional issues found

- `computer_apps` reports `input:dispatched` through the generic action formatter even though it performs discovery, not input.
- The extension throws the text of every error result. That loses images and structured details if the workflow starts returning useful recovery images. Fixing only the workflow is insufficient.
- The workflow marks dispatch before calling the adapter. The adapter still performs desktop checks, connection setup, and process ownership checks before the actual native RPC. A failure there becomes uncertain input even when the adapter can prove no action request was sent.
- A failed post-action capture hides its original reason behind `Post-action capture failed.` Closing or minimizing the observed window can make that capture unavailable without proving that the preceding input failed.
- Cleanup errors can replace or reclassify the original action result. Cleanup status and input status need separate handling.
- Recovery text repeatedly discusses foreground typing even for discovery and unrelated operations. Guidance should describe the failed operation and a callable next step.
- The adapter's blanket 15-second RPC timeout is shorter than the native Windows launch path's possible total duration. That path can include a 4-second name lookup, a 15-second shell launch, and additional window/host polling. A timeout can therefore interrupt result collection after an app starts. This is a confirmed timeout-budget mismatch, not proof of the specific Explorer failure.

### Evidence and limitations

The local inert probe is `%TEMP%/lunr-computer-plan-probe.mjs`. It imports the installed compiled workflow, uses a fake driver and fake lease, and processes generated PNGs. It never creates a native adapter or acquires the real desktop lease.

`node %TEMP%/lunr-computer-plan-probe.mjs` reproduced four current behaviors: skipped post-image on refusal, unconditional failed-launch guidance, discovery token invalidation, and workflow closure on token expiry. Its `--desired-contract` mode fails with `0 !== 1` because the refusal result has no recovery image. This is a deterministic failing check for the reporting path, not a reproduction of the real Windows click failure. Port the useful scenarios into the existing test suites during implementation; the temporary probe is not a permanent dependency.

No original taskbar-session trace was supplied. Do not claim that the native click problem is fixed until a controlled live test identifies and exercises that failure path.

Independent pinned-source inspection found a native example of post-attempt uncertainty: Windows `finish_pixel_uia_attempt` can return `background_unavailable` with `effect:unverifiable` after UIA Busy/Timeout/Unavailable. That does not prove no click happened. It explains why a refusal must not automatically be treated as safe to retry, but it does not identify the user's particular `tool_invocation_failed` path. Windows launch also has plain-text native error replies, which `driverData` intentionally omits instead of forwarding unchecked text. Keep that privacy boundary while adding safe normalized reasons. The source is the pinned [Windows tool implementation](https://raw.githubusercontent.com/trycua/cua/d8028a7943087ee258dc1b4d19dc12a7cd27669c/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs).

## 1. Establish a precise outcome contract

**Priority: first.** Files: `src/core/computer-use/workflow.ts`, `adapter.ts`, and the existing workflow/adapter tests under `packages/coding-agent`.

Replace the loose `refused_or_failed` category with a typed internal result that keeps these facts separate:

- Operation and target.
- Failure phase: validation, adapter preflight, native request, native result, post-action capture, or cleanup.
- Input state: definitely not dispatched, dispatched without effect verification, partial when delivery counts establish it, or uncertain.
- A stable lunR reason code, plus bounded native code when available.
- Observation state: available, unavailable, or not requested.
- Workflow state: ready for observation, stopped, or cleanup unconfirmed.
- Conditional recovery guidance.

A native request being sent is not proof that Windows delivered input. An acknowledged action is not proof that the intended button was clicked. Keep `applicationEffect:unverified` unless there is an explicit, separately justified verification mechanism. The agent inspects images for the task's actual result.

Move evidence of request dispatch to the adapter boundary immediately before `client.callTool`. Preserve whether setup/preflight failed before that point. If cancellation or a transport error races with dispatch and delivery cannot be established, report uncertainty. Never infer `not_dispatched` from a generic native error code alone.

Normalize known native refusal shapes with an allowlist. Preserve safe structured codes for stale targets, foreground rejection, background delivery limits, and verification failure. Map recognized native diagnostic patterns to stable reasons where possible. Unknown errors remain `native_error_unknown`; this is better than inventing a cause. Keep raw stderr, accessibility trees, typed text, command lines, and arbitrary native exception strings out of results. Truncation alone does not make a diagnostic safe.

Keep cleanup as a separate result field. If shutdown fails after an action result, retain that result and mark cleanup unconfirmed. Retain desktop ownership until shutdown is confirmed. Do not convert a known partial result into an undifferentiated dispatch failure.

**Complete when:** fake preflight refusals prove zero action RPCs; transport uncertainty remains uncertain; known native codes survive normalization; unknown errors remain explicitly unknown; cleanup failure preserves the original operation outcome.

## 2. Return evidence after uncertain native actions

**Priority: first, alongside step 1.** Files: `workflow.ts`, `builtin-extensions/lunr-computer-use.ts`, `computer-use.test.ts`, and `computer-extension.test.ts`.

For a completed native reply that reports refusal, partial delivery, or failed verification, attempt one capture of the original observed target if the runtime is healthy, the lease is valid, and the operation is not cancelled. The capture is observation only. It must not focus a window, retry input, or silently escalate to foreground.

Return the native outcome and this image together. If capture succeeds, issue a fresh single-action token. Instruct the agent to inspect the image before choosing any further action. The error flag must not imply that the input had no effect.

If capture fails:

- Preserve both the native outcome and a bounded capture reason.
- Issue no usable token.
- Distinguish an unavailable target from a decode failure or transport failure where evidence permits.
- For a disappeared window, suggest explicit app/window discovery or a desktop observation. Do not automatically capture a different window or the whole desktop.
- For transport loss, cancellation, ownership loss, or unsafe native state, stop and confirm cleanup. Do not restart the runtime to obtain a recovery image behind the caller's back.

Do not automatically capture after a launch using a guessed window identity. Launch has its own discovery contract in step 4.

Preserve error images through the real tool-result path. The current extension converts `result.isError` into a text-only exception. The agent loop does not honor a returned top-level `isError` by itself. Use a computer-specific detail marker and the existing `tool_result` hook to set the final error flag while preserving content and details. The MCP adapter already uses this pattern. Keep it scoped to registered computer tools; do not redesign the shared agent result API.

An unchanged screenshot neither proves input failure nor authorizes replay. Keep duplicate-action protection for uncertain and partial results as well as acknowledged actions where the evidence supports it. Do not use unrelated image changes as proof of success.

**Complete when:** a fake click changes pixels and returns a native error, yet the model-visible result contains that error and exactly one new image; only one action RPC occurred; no image is lost by the extension or agent loop. Cancelled calls and broken runtimes never trigger recovery captures.

## 3. Make observation mistakes recoverable

**Priority: next.** Files: `workflow.ts`, `lunr-computer-use.ts`, `schemas.ts`, and focused lifecycle tests.

Classify errors by whether they require runtime shutdown, rather than closing on every `isError`.

Recoverable cases include an expired, missing, mismatched, or wrong-target token and locally rejected coordinates or arguments. Consume or invalidate the old token and return `input:not_dispatched`. Leave a healthy runtime and its lease available for a new full observation. Do not silently refresh a token and execute the original action against a different image.

Preserve a valid observation across `computer_apps`, since it performs discovery. Preserve its original age and target binding; discovery must not refresh its expiry. Launch, input, window mutation, a new observation attempt, cancellation, and session replacement still invalidate the old observation.

Keep the 30-second lifetime and exact single-use target binding. Return compact capture/expiry metadata so the agent can tell when a new observation is needed. Retain a conservative capture-time basis; encoding or a slow provider response must not make old pixels appear fresh. Use controlled time in tests.

Reserve workflow termination for explicit end, agent/session end, settings or permission changes, cancellation, lease loss, broken transport, unsafe driver state, and unconfirmed cleanup. Keep the unchanged-image polling limit, but make its returned state and next step accurate. A recoverable error must not reset polling or duplicate-action history merely to bypass those protections.

The current extension already retains loaded tool registration across ordinary errors and lazily creates a workflow on the next call. Do not make `computer_load` a mandatory recovery step when `computer_observe` is still available. `computer_load` exposes tools; it does not itself repair a native runtime.

Exercise serialization during these transitions. A queued action cannot use a token invalidated by a preceding action/error, and stop/settings changes must prevent queued input from starting.

**Complete when:** the same loaded workflow rejects an expired token with zero native input, accepts a new observation, and performs one action using its new token. Discovery preserves a still-valid token but cannot extend its lifetime. Fatal failures retain the existing cleanup and ownership guarantees.

## 4. Correct launch reporting and recovery

**Priority: next.** Files: the discovery/launch branch in `workflow.ts`, launch description in `lunr-computer-use.ts`, and tests.

Keep `computer_launch({name})`. Observation tokens belong to image-grounded input, not app launch.

Split launch formatting from discovery and pointer/keyboard input. Report what is known about launch dispatch, app identity, activation, and window discovery rather than forcing them into one success/failure flag.

- If launch fails before dispatch, report that no launch request was sent and give the actual safe reason.
- If dispatch occurs but activation or window discovery fails, report possible launch completion. Tell the agent to use `computer_apps({query:name})`, or `computer_apps({pid})` when a valid PID was returned, before considering another launch.
- If a usable window identity is returned, explicitly name `computer_observe({pid,window_id})` as the next operation.
- If launch is acknowledged without a window identity, report that honestly and direct the agent to discovery. Do not promise a returned window.

Replace the blanket 15-second launch RPC timeout with an operation-specific budget derived from the pinned launch stages. Keep it within the workflow's 90-second outer deadline and preserve immediate cancellation. Test the boundary with fake timers: a result arriving beyond 15 seconds but within the allowed launch budget must be received, and an exhausted budget must return uncertainty with no retry. Do not raise every tool's timeout to mask unrelated hangs.

Windows shell activation can reuse an existing process and return PID zero or no windows. Do not treat that as proof of launch failure or pass zero to PID-based tools. Fall back to named discovery.

Do not auto-launch again on a timeout or assume a visible Explorer window proves which earlier call opened it. Preserve allowlisted launch-specific codes while inspecting the native implementation for failures after process creation or activation.

**Complete when:** launch failure guidance uses only valid tool arguments, differentiates pre-dispatch from uncertain outcomes, and never asks for an observation token on `computer_launch`. A fake successful process start followed by failed metadata lookup is not described as definitely unlaunched.

## 5. Improve named-app window discovery

**Priority: after reporting and recovery.** Files: `schemas.ts`, the discovery formatter, tool description, and discovery tests.

First fix the existing contract:

- Return a clear result kind for apps versus windows.
- Omit input-delivery claims on discovery results.
- For a running app without window details, return a concise, valid PID-based next step.
- State that a query filters the requested collection. A title search across every app is not currently implemented.

Then add optional `include_windows` to `computer_apps`. With a named query and this option, fetch windows for matching positive PIDs through the existing native `list_windows` operation. Keep unfiltered browsing and ordinary app queries cheap.

Use explicit budgets, initially at most five matching running PIDs and 50 window rows total per call. If more processes match, return the app identities and ask the agent to narrow the query or choose a PID rather than silently selecting an arbitrary first process. Mark per-PID failure and truncation; preserve successful results when one PID exits during lookup. Reuse existing PID-based window pagination for follow-up calls. Check cancellation between native calls.

Return PID, window ID, title, available bounds, and existing visibility/minimized facts only. Preserve native target identity rather than assuming an app process always owns its visible window; UWP windows can belong to `ApplicationFrameHost`. Cover this in discovery tests. Negative coordinates or an off-primary location do not make a window invalid. Bounds remain native geometry, not screenshot coordinates. Include direct observation guidance for valid windows. Do not infer taskbar-icon identity from process name alone.

**Complete when:** one enriched Discord query can return its valid window target; multiple matching processes remain distinguishable; PID zero never triggers window lookup; budgets, partial errors, and pagination are explicit; off-primary windows remain observable.

## 6. Add image-grounded hover

**Priority: separate usability change after safe outcomes are in place.** Files: schemas, policy/tool lists, workflow dispatch, extension descriptions, and native support only if required.

Start with a Windows desktop-only `computer_hover`, not an accessibility-tree feature. It takes `desktop:true`, `foreground:true`, an exact desktop observation token, and returned-image x/y. Pointer movement is a mutation even without a click, so read-only mode must block it. Do not accept PID/window arguments in this first version.

Pinned Windows CuaDriver exposes `move_cursor`. Its desktop mode uses `SetCursorPos` to move the real pointer. Its window mode moves a synthetic overlay, not the application's pointer, and lunR launches with `--no-overlay`. Therefore desktop hover can be investigated without changing the pin, but window-mode movement must not be advertised as real application hover. This is source evidence, not live qualification. See the pinned [Windows implementation](https://raw.githubusercontent.com/trycua/cua/d8028a7943087ee258dc1b4d19dc12a7cd27669c/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs), `MoveCursorTool`.

Use a real pointer move without button-down/up or focus activation. Consume the token, wait a short bounded dwell to allow a tooltip to appear, then return one post-hover image. Start with a fixed documented dwell, approximately 700 ms, rather than adding arbitrary polling. The wait must be cancellable. A missing tooltip is an observation, not grounds for automatic repeated hovering. Movement may trigger app behavior; do not describe hover as side-effect-free.

Map full-desktop and cropped-desktop coordinates through the same tested conversion as clicks. A tooltip outside the selected crop should appear in the full-desktop post-image. The primary desktop remains the target; this does not add all-monitor capture. The visible topmost app receives real hover, so the tool must not claim background or occlusion-safe delivery.

Verify desktop origin and DPI mapping against this native operation before exposing it. Qualify macOS separately and register the capability only on hosts with verified support. Real background-window hover requires a separate native patch or pin upgrade. Do not simulate hover with a click, a zero-distance drag, or an unrelated shell automation workaround.

Accessible taskbar names remain a possible later feature. They would introduce a new observation contract and require separate scope approval. Smooth cursor animation is also outside this fix.

**Complete when:** the tool moves the pointer without any button events, respects permissions and cancellation, returns one bounded image, and can reveal a taskbar tooltip in an authorized Windows test. Unsupported hosts receive accurate capability reporting.

## 7. Diagnose and repair the native failure path

Run this after phase-specific reporting can distinguish the possibilities. It is not permission to operate the user's desktop now.

Ranked hypotheses for the worked-but-failed clicks:

1. Input was delivered, then native verification or response construction failed.
2. The native gesture partly executed before an input/focus helper returned an error.
3. lunR interpreted a native response as a refusal despite an acknowledged request.

For launch, also test process creation succeeding before activation or window metadata lookup fails. A screenshot showing an app is open does not establish which call launched it.

Build deterministic native tests or fault injection around the identified boundary before changing delivery code. Record phase, safe native code, request completion, and cleanup status. Use synthetic fixture text and private artifacts; avoid broad raw desktop logging.

If the pinned runtime is responsible, compare a minimal patch with a specific upstream fix. Reuse the existing native transport rather than building a second Windows automation system. A patched or upgraded binary needs its own source provenance, artifact hashes, platform coverage, packaging checks, and approval. Keep CuaDriver production approval separate from lunR wrapper fixes.

**Complete when:** a test fails at the actual native boundary, passes with the selected fix, and the original controlled GUI scenario no longer loses or misstates delivery evidence. If the original native cause remains unreproduced, report that limit explicitly.

## Validation and delivery

### Focused automated tests

Extend existing suites rather than creating a broad new test framework:

- `computer-use.test.ts`: phase outcomes, single recovery image, token recovery, discovery preservation, partial Unicode delivery, launch guidance, off-primary discovery, unchanged-image safeguards.
- `computer-adapter.test.ts`: setup/preflight versus actual RPC dispatch, launch-specific timeout budgets, transport failure, cancellation, and cleanup evidence.
- `computer-extension.test.ts`: recoverable versus fatal workflow lifecycle, rich error content through `tool_result`, loaded tools, settings changes, session end, and permission changes.
- `computer-image-photon.test.ts`: real PNG recovery images and full/crop coordinate mapping for hover. Retain existing decoded-pixel tests.
- Policy and tool-coverage tests: hover is a mutation, foreground policy holds, children cannot invoke native tools, and platform capability registration matches the schemas.

Include one actual agent-loop fixture proving that an error flag and image reach the final tool result together. A workflow-only assertion will miss the current extension's text-only exception conversion.

Run the offline package build order and Node bundle only in the isolated implementation checkout. Run existing first-request/tool-coverage checks and regenerate affected inventories or fingerprints. Detailed tools load on demand, so test the loaded roster as well as the initial `computer_load` roster. Update shipped computer-use docs and the implementation branch's `AGENTS.md` with verified behavior. Regenerate affected private prompt snapshots; keep them private.

### Separately approved Windows acceptance

Use the actual registered tools from an isolated dev build. Start with owned scratch windows and a fixed synthetic phrase, not the user's existing taskbar shortcut or documents.

Verify:

1. A dialog-closing click returns honest delivery status even when the original target disappears.
2. Taskbar/context-menu clicks produce one input attempt and useful post-action evidence.
3. Explorer launch gives valid discovery guidance without repeating launch on uncertainty.
4. A token older than 30 seconds is refused, followed by a fresh capture without a load/restart ritual.
5. An enriched named-app lookup finds an off-primary window and targeted observation still captures it.
6. Hover reveals a taskbar tooltip without clicking.
7. Full and cropped targets map correctly at the test machine's display scaling; include a second display and changed window geometry where available.
8. Cancellation sends no follow-up input or recovery capture; `computer_end` confirms runtime shutdown and lease release.

Record the exact tested build and platform. Windows x64 results do not qualify Windows arm64 or macOS. Cross-platform changes need their own native acceptance, especially hover, focus, and held-input cleanup. Ask separately before any test that changes the user's real taskbar pins, files, permissions, or existing app state.

### Delivery split

1. **Reporting and recovery PR:** steps 1 through 4, including rich error images, safe token recovery, and discovery's accidental token invalidation.
2. **Discovery improvement PR:** step 5, built on the corrected result contract.
3. **Hover/native PR:** step 6 and any confirmed native fix from step 7, with a separate runtime decision if needed.

These can share investigation, but native changes must not block the wrapper's confirmed reporting fixes. Use one writer per checkout. Publication, installation, stable merge, and real-desktop testing each require their own authorization.

## Final acceptance criteria

- The agent can distinguish input definitely not sent from input that may have taken effect.
- An ordinary settled native refusal does not automatically discard the available recovery image or healthy workflow.
- Recovery images, error flags, and structured outcomes survive the extension and agent loop together.
- Launch recovery uses the actual launch/discovery schemas and never encourages blind relaunch.
- Invalid tokens remain invalid; a fresh observation restores progress without weakening freshness or target binding.
- Read-only discovery does not silently destroy a valid observation or claim it sent input.
- Window enrichment stays bounded and preserves off-primary targets.
- Hover uses actual pointer movement and stays subject to mutation permissions.
- No input retries, hidden foreground escalation, raw diagnostic leakage, or ownership release before confirmed shutdown.
- Any unverified native cause, unsupported host, or outstanding live acceptance is stated plainly.
