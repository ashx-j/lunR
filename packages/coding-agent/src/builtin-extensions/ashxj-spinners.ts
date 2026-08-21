import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spinners } from "unicode-animations";

// Spinners come from the `unicode-animations` package; see
// https://www.npmjs.com/package/unicode-animations for the full catalog.
// On each state entry we pick a random spinner from that state's pool, and
// we re-roll the kaomoji on a timer while the state is active (see
// KAOMOJI_REROLL_MS), so the working-indicator row keeps varying instead of
// freezing on one (spinner, kaomoji) pair for the whole state.
type SpinnerName = keyof typeof spinners;

type State = "idle" | "startup" | "thinking" | "searching" | "editing" | "toolRunning" | "complete" | "error";

// `thinking` and `toolRunning` share one combined pool for both spinners and
// kaomoji, so the two states are visually interchangeable. The combined
// spinner pool is the union of the former thinking spinners (rain, breathe,
// checkerboard, sparkle) and the former toolRunning spinners (braille,
// snake). The combined kaomoji pool is the union of both former kaomoji
// sets plus the new toolRunning entries below (6 spinners x 14 kaomoji).
const THINKING_TOOL_SPINNER_POOL: readonly SpinnerName[] = [
  "rain",
  "breathe",
  "checkerboard",
  "sparkle",
  "braille",
  "snake",
];

const THINKING_TOOL_KAOMOJI_POOL: readonly string[] = [
  // formerly `thinking`
  "(ᵕ—ᴗ—)",            // determined
  "(˵ ¬ᴗ¬˵)",            // clever
  "(⸝⸝ᵕᴗᵕ⸝⸝)",         // admiring gaze
  "⸜(｡˃ ᵕ ˂ )⸝♡",      // blushing happy
  "(˶>⩊<˶)",            // cheerful
  "૮⸝⸝> ̫ <⸝⸝ ა",      // pleading with worry
  "(˶  >   ₃  < ˶)",     // licking lips
  // formerly `toolRunning`
  "(๑´>᎑<)~*",          // reaching for hug, eager
  // new
  "₍^. .^₎⟆",
  "(ㅅ´ ˘ `)",
  "(„• ֊ •„)",
  "(˶˃ ᵕ ˂˶)",
  "⡞⠳⣄⣀⣠⠞⢷ ֹ۪",
  "（˶•̀ ᎑-˶）",
];

const SPINNER_POOL_FOR_STATE: Record<State, readonly SpinnerName[]> = {
  idle:        [],
  startup:     [],
  thinking:    THINKING_TOOL_SPINNER_POOL,
  searching:   ["diagswipe", "scan", "cascade"],
  editing:     ["columns", "fillsweep"],
  toolRunning: THINKING_TOOL_SPINNER_POOL,
  complete:    [],
  error:       ["pulse"],
};

const KAOMOJI_FOR_STATE: Record<State, readonly string[]> = {
  // idle, startup, complete are silent: no kaomoji.
  idle:        [],
  startup:     [],
  thinking:    THINKING_TOOL_KAOMOJI_POOL,
  searching:   [
    "(⸝⸝⩌ ⤙ ⩌⸝⸝)",       // confused
    "(╹ -╹)?",             // questioning
  ],
  editing:     [
    "(ᵕ • ᴗ •)",           // content
    "(˶ᵔ ᵕ ᵔ˶) ‹𝟹",        // warm with small heart
    "(๑ᵔ⤙ᵔ๑)",            // gleeful
  ],
  toolRunning: THINKING_TOOL_KAOMOJI_POOL,
  complete:    [],
  error:       [
    "(,,>﹏<,,)",           // crying
    "(⸝⸝ ♡﹏♡⸝⸝)",        // apologetic crying
    "\"૮₍ ˶•⤙•˶ ₎ა",     // pleading paws
    "(╥﹏╥)",               // heavy crying
    "(˶°ㅁ°)!!",           // shocked
    "(,,•᷄﹏‎•᷅,,)",       // distressed
  ],
};

const SEARCH_RE = /(search|find|grep|list|ls|fuzzy|query)/i;
const EDIT_RE = /(^|[_\-\s])(write|edit|patch|create|delete|remove|replace|insert|update|apply_?patch|apply_?edit|str_?replace|str_?replace_?editor|create_?file|delete_?file|write_?file|edit_?file|insert_?content|append_?file|modify_?file)([_\-\s]|$)/i;

const TRANSIENT_MS = 3000;
// Minimum time a visible "active" state must persist before being replaced.
// Prevents flicker (e.g. error -> thinking clobbering the error before the
// user can see it). The TTL only gates active->active transitions:
//   - Active -> active: TTL applies (within 3s, the new state is rejected)
//   - Active -> silent (idle/startup/complete): TTL bypassed (end-of-turn)
//   - Active -> error: TTL bypassed (error always wins)
//   - Silent -> active: TTL bypassed (silent states aren't in STATES_WITH_TTL)
// Auto-revert timers bypass this by calling doApplyState directly.
const STATE_TTL_MS = 3000;
const STATES_WITH_TTL: ReadonlySet<State> = new Set<State>([
  "thinking", "searching", "editing", "toolRunning", "error",
]);
const SILENT_STATES: ReadonlySet<State> = new Set<State>([
  "idle", "startup", "complete",
]);

// How often the kaomoji is re-rolled while an active state is showing. Set
// long (30 s) so it only kicks in for genuinely long tasks; short states
// finish before the first re-roll and show a single kaomoji. The spinner is
// NOT re-rolled on this timer (restarting its animation would stutter); the
// spinner only changes on state transitions.
const KAOMOJI_REROLL_MS = 30000;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// Like pick, but never returns `current` (so a re-roll always produces a
// visible change). Pools of length <= 1 can't vary, so they return the
// sole element unchanged.
function pickOther<T>(arr: readonly T[], current: T): T {
  if (arr.length <= 1) return arr[0]!;
  let v: T;
  do {
    v = pick(arr);
  } while (v === current);
  return v;
}

export default function (pi: ExtensionAPI): void {
  let state: State = "idle";
  let stateEnteredAt = 0;
  let currentKaomoji = "";
  let transientTimer: ReturnType<typeof setTimeout> | undefined;
  let rerollTimer: ReturnType<typeof setInterval> | undefined;

  function clearTransient(): void {
    if (transientTimer !== undefined) {
      clearTimeout(transientTimer);
      transientTimer = undefined;
    }
  }

  function clearReroll(): void {
    if (rerollTimer !== undefined) {
      clearInterval(rerollTimer);
      rerollTimer = undefined;
    }
  }

  function doApplyState(next: State, ctx: ExtensionContext): void {
    state = next;
    stateEnteredAt = Date.now();

    const spinnerPool = SPINNER_POOL_FOR_STATE[next];
    if (spinnerPool.length > 0) {
      const spinnerName = pick(spinnerPool);
      const def = spinners[spinnerName];
      const frames = def.frames.map(f => ctx.ui.theme.fg("accent", f));
      ctx.ui.setWorkingIndicator({ frames, intervalMs: def.interval });
    } else {
      ctx.ui.setWorkingIndicator({ frames: [] });
    }

    const kaomojiPool = KAOMOJI_FOR_STATE[next];
    currentKaomoji = kaomojiPool.length > 0 ? pick(kaomojiPool) : "";
    ctx.ui.setWorkingMessage(currentKaomoji);

    clearReroll();
    clearTransient();

    // Re-roll the kaomoji periodically while an active state is showing, so
    // a long thinking / toolRunning / error / searching / editing stretch
    // cycles through kaomoji instead of freezing on one. The spinner stays
    // put for the whole state (see KAOMOJI_REROLL_MS). Pools of length <= 1
    // can't vary, so skip them; silent states have empty pools and are also
    // skipped.
    if (kaomojiPool.length > 1) {
      rerollTimer = setInterval(() => rerollKaomoji(ctx), KAOMOJI_REROLL_MS);
    }

    if (next === "complete" || next === "startup") {
      transientTimer = setTimeout(() => doApplyState("idle", ctx), TRANSIENT_MS);
    }
  }

  function rerollKaomoji(ctx: ExtensionContext): void {
    const pool = KAOMOJI_FOR_STATE[state];
    if (pool.length <= 1) return;
    currentKaomoji = pickOther(pool, currentKaomoji);
    ctx.ui.setWorkingMessage(currentKaomoji);
  }

  function applyState(next: State, ctx: ExtensionContext, options: { force?: boolean } = {}): void {
    if (ctx.mode !== "tui") return;
    // Enforce minimum TTL on event-driven transitions, with three exceptions:
    //   - `error` always wins (so tool_execution_end can always set error).
    //   - Silent states (idle, startup, complete) bypass TTL — they're
    //     end-of-turn markers, not active states that need minimum display.
    //     Without this, agent_end within 3s of turn_start would be rejected,
    //     leaving the spinner stuck in the active state.
    //   - `force: true` bypasses TTL — used for tool_execution_start so the
    //     spinner syncs with the tool bubble the moment it appears.
    // Auto-revert timers bypass this by calling doApplyState directly.
    if (
      !options.force &&
      !SILENT_STATES.has(next) &&
      next !== "error" &&
      STATES_WITH_TTL.has(state) &&
      Date.now() - stateEnteredAt < STATE_TTL_MS
    ) {
      return;
    }
    doApplyState(next, ctx);
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    // lunr: do not ctx.ui.setTitle here — InteractiveMode owns the OSC title
    // (`lunr - [session -] cwd`). Overwriting it with a brand string made
    // Windows Terminal tabs say "ashxj" (or left them as "node" until this ran).
    doApplyState(event.reason === "startup" ? "startup" : "idle", ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    applyState("thinking", ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    // Hook on tool_execution_start (not tool_call) so the spinner activates
    // at the same moment the tool bubble appears in the UI. tool_call fires
    // earlier (when the LLM decides to call the tool, before execution), and
    // the bubble only appears once the tool actually starts — so hooking on
    // tool_call creates a visual desync between spinner and bubble.
    // Bonus: tools blocked at tool_call never run, so tool_execution_start
    // won't fire and the spinner won't activate for blocked tools.
    // `force: true` bypasses the 3s TTL so the spinner syncs with the
    // bubble immediately, even if the previous active state is still
    // within its minimum display window.
    if (state === "error") return;
    const name = event.toolName;
    const force = true;
    if (SEARCH_RE.test(name)) {
      applyState("searching", ctx, { force });
    } else if (EDIT_RE.test(name)) {
      applyState("editing", ctx, { force });
    } else {
      applyState("toolRunning", ctx, { force });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError) {
      applyState("error", ctx);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    // A turn that ran a tool ends with the spinner still on the tool state
    // (searching/editing/toolRunning). The next turn_start would revert to
    // thinking, but it's TTL-gated and gets rejected for fast tools (<3s),
    // which leaves the spinner stuck on the tool state for the whole next
    // turn. Revert to thinking here, right after the turn's tools finish.
    // turn_end fires once per turn after all its (concurrent) tools
    // complete, so this is safe for parallel tool calls. Only force out of
    // tool states, never out of error (error has priority and is handled
    // by agent_end). No-op on turns that had no tools (state is already
    // thinking).
    if (state === "searching" || state === "editing" || state === "toolRunning") {
      applyState("thinking", ctx, { force: true });
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const last = event.messages.at(-1);
    if (!last || last.role !== "assistant") {
      applyState("idle", ctx);
      return;
    }
    const stopReason = (last as { stopReason?: string }).stopReason;
    if (stopReason === "stop" || stopReason === "length") {
      applyState("complete", ctx);
    } else if (stopReason === "error" || stopReason === "aborted") {
      applyState("error", ctx);
    } else if (stopReason === "toolUse") {
    } else {
      applyState("idle", ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTransient();
    clearReroll();
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingIndicator({ frames: [] });
      ctx.ui.setWorkingMessage("");
    }
    state = "idle";
    stateEnteredAt = 0;
    currentKaomoji = "";
  });
}