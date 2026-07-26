/**
 * WorkingIndicatorController — spinner + kaomoji working indicator (absorbed
 * from the former ashxj-spinners baked-in extension into core).
 *
 * Spinners come from the `unicode-animations` package. On each state entry we
 * pick a random spinner from that state's pool, and we re-roll the kaomoji on
 * a timer while the state is active (see KAOMOJI_REROLL_MS), so the
 * working-indicator row keeps varying instead of freezing on one
 * (spinner, kaomoji) pair for the whole state.
 *
 * InteractiveMode drives this from agent events; the controller talks back
 * through the injected sink. (The upstream extension also set the terminal
 * title to "ashxj" on session start — dropped: lunR owns the terminal title.)
 */

import { spinners } from "unicode-animations";
import type { WorkingIndicatorOptions } from "../core/extensions/index.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

type SpinnerName = keyof typeof spinners;

type State = "idle" | "startup" | "thinking" | "searching" | "editing" | "toolRunning" | "complete" | "error";

export interface WorkingIndicatorSink {
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	setWorkingMessage(message?: string): void;
}

// `thinking` and `toolRunning` share one combined pool for both spinners and
// kaomoji, so the two states are visually interchangeable.
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
	"(ᵕ—ᴗ—)", // determined
	"(˵ ¬ᴗ¬˵)", // clever
	"(⸝⸝ᵕᴗᵕ⸝⸝)", // admiring gaze
	"⸜(｡˃ ᵕ ˂ )⸝♡", // blushing happy
	"(˶>⩊<˶)", // cheerful
	"૮⸝⸝> ̫ <⸝⸝ ა", // pleading with worry
	"(˶  >   ₃  < ˶)", // licking lips
	// formerly `toolRunning`
	"(๑´>᎑<)~*", // reaching for hug, eager
	// new
	"₍^. .^₎⟆",
	"(ㅅ´ ˘ `)",
	"(„• ֊ •„)",
	"(˶˃ ᵕ ˂˶)",
	"⡞⠳⣄⣀⣠⠞⢷ ֹ۪",
	"（˶•̀ ᎑-˶）",
];

const SPINNER_POOL_FOR_STATE: Record<State, readonly SpinnerName[]> = {
	idle: [],
	startup: [],
	thinking: THINKING_TOOL_SPINNER_POOL,
	searching: ["diagswipe", "scan", "cascade"],
	editing: ["columns", "fillsweep"],
	toolRunning: THINKING_TOOL_SPINNER_POOL,
	complete: [],
	error: ["pulse"],
};

const KAOMOJI_FOR_STATE: Record<State, readonly string[]> = {
	// idle, startup, complete are silent: no kaomoji.
	idle: [],
	startup: [],
	thinking: THINKING_TOOL_KAOMOJI_POOL,
	searching: [
		"(⸝⸝⩌ ⤙ ⩌⸝⸝)", // confused
		"(╹ -╹)?", // questioning
	],
	editing: [
		"(ᵕ • ᴗ •)", // content
		"(˶ᵔ ᵕ ᵔ˶) ‹𝟹", // warm with small heart
		"(๑ᵔ⤙ᵔ๑)", // gleeful
	],
	toolRunning: THINKING_TOOL_KAOMOJI_POOL,
	complete: [],
	error: [
		"(,,>﹏<,,)", // crying
		"(⸝⸝ ♡﹏♡⸝⸝)", // apologetic crying
		'"૮₍ ˶•⤙•˶ ₎ა', // pleading paws
		"(╥﹏╥)", // heavy crying
		"(˶°ㅁ°)!!", // shocked
		"(,,•᷄﹏‎•᷅,,)", // distressed
	],
};

const SEARCH_RE = /(search|find|grep|list|ls|fuzzy|query)/i;
const EDIT_RE =
	/(^|[_\-\s])(write|edit|patch|create|delete|remove|replace|insert|update|apply_?patch|apply_?edit|str_?replace|str_?replace_?editor|create_?file|delete_?file|write_?file|edit_?file|insert_?content|append_?file|modify_?file)([_\-\s]|$)/i;

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
	"thinking",
	"searching",
	"editing",
	"toolRunning",
	"error",
]);
const SILENT_STATES: ReadonlySet<State> = new Set<State>(["idle", "startup", "complete"]);

// How often the kaomoji is re-rolled while an active state is showing. Set
// long (30 s) so it only kicks in for genuinely long tasks; short states
// finish before the first re-roll and show a single kaomoji. The spinner is
// NOT re-rolled on this timer (restarting its animation would stutter); the
// spinner only changes on state transitions.
const KAOMOJI_REROLL_MS = 30000;

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)] as T;
}

// Like pick, but never returns `current` (so a re-roll always produces a
// visible change). Pools of length <= 1 can't vary, so they return the
// sole element unchanged.
function pickOther<T>(arr: readonly T[], current: T): T {
	if (arr.length <= 1) return arr[0] as T;
	let v: T;
	do {
		v = pick(arr);
	} while (v === current);
	return v;
}

export class WorkingIndicatorController {
	private state: State = "idle";
	private stateEnteredAt = 0;
	private currentKaomoji = "";
	private transientTimer: ReturnType<typeof setTimeout> | undefined;
	private rerollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly sink: WorkingIndicatorSink;

	constructor(sink: WorkingIndicatorSink) {
		this.sink = sink;
	}

	private clearTransient(): void {
		if (this.transientTimer !== undefined) {
			clearTimeout(this.transientTimer);
			this.transientTimer = undefined;
		}
	}

	private clearReroll(): void {
		if (this.rerollTimer !== undefined) {
			clearInterval(this.rerollTimer);
			this.rerollTimer = undefined;
		}
	}

	private doApplyState(next: State): void {
		this.state = next;
		this.stateEnteredAt = Date.now();

		const spinnerPool = SPINNER_POOL_FOR_STATE[next];
		if (spinnerPool.length > 0) {
			const spinnerName = pick(spinnerPool);
			const def = spinners[spinnerName];
			const frames = def.frames.map((f) => theme.fg("accent", f));
			this.sink.setWorkingIndicator({ frames, intervalMs: def.interval });
		} else {
			this.sink.setWorkingIndicator({ frames: [] });
		}

		const kaomojiPool = KAOMOJI_FOR_STATE[next];
		this.currentKaomoji = kaomojiPool.length > 0 ? pick(kaomojiPool) : "";
		this.sink.setWorkingMessage(this.currentKaomoji);

		this.clearReroll();
		this.clearTransient();

		// Re-roll the kaomoji periodically while an active state is showing, so
		// a long thinking / toolRunning / error / searching / editing stretch
		// cycles through kaomoji instead of freezing on one.
		if (kaomojiPool.length > 1) {
			this.rerollTimer = setInterval(() => this.rerollKaomoji(), KAOMOJI_REROLL_MS);
		}

		if (next === "complete" || next === "startup") {
			this.transientTimer = setTimeout(() => this.doApplyState("idle"), TRANSIENT_MS);
		}
	}

	private rerollKaomoji(): void {
		const pool = KAOMOJI_FOR_STATE[this.state];
		if (pool.length <= 1) return;
		this.currentKaomoji = pickOther(pool, this.currentKaomoji);
		this.sink.setWorkingMessage(this.currentKaomoji);
	}

	private applyState(next: State, options: { force?: boolean } = {}): void {
		// Enforce minimum TTL on event-driven transitions, with three exceptions:
		//   - `error` always wins (so tool_execution_end can always set error).
		//   - Silent states (idle, startup, complete) bypass TTL — they're
		//     end-of-turn markers, not active states that need minimum display.
		//   - `force: true` bypasses TTL — used for tool_execution_start so the
		//     spinner syncs with the tool bubble the moment it appears.
		if (
			!options.force &&
			!SILENT_STATES.has(next) &&
			next !== "error" &&
			STATES_WITH_TTL.has(this.state) &&
			Date.now() - this.stateEnteredAt < STATE_TTL_MS
		) {
			return;
		}
		this.doApplyState(next);
	}

	/** reason "startup" shows the transient startup state; anything else goes idle. */
	onSessionStart(reason?: string): void {
		this.doApplyState(reason === "startup" ? "startup" : "idle");
	}

	onTurnStart(): void {
		this.applyState("thinking");
	}

	onToolExecutionStart(toolName: string): void {
		// Hooked on tool_execution_start (not tool_call) so the spinner activates
		// at the same moment the tool bubble appears in the UI. `force` bypasses
		// the 3s TTL so the spinner syncs with the bubble immediately.
		if (this.state === "error") return;
		if (SEARCH_RE.test(toolName)) {
			this.applyState("searching", { force: true });
		} else if (EDIT_RE.test(toolName)) {
			this.applyState("editing", { force: true });
		} else {
			this.applyState("toolRunning", { force: true });
		}
	}

	onToolExecutionEnd(isError: boolean): void {
		if (isError) {
			this.applyState("error");
		}
	}

	onTurnEnd(): void {
		// A turn that ran a tool ends with the spinner still on the tool state.
		// The next turn_start would revert to thinking, but it's TTL-gated and
		// gets rejected for fast tools (<3s), leaving the spinner stuck on the
		// tool state for the whole next turn. Revert to thinking here, right
		// after the turn's tools finish. Only force out of tool states, never
		// out of error (error has priority and is handled by agent_end).
		if (this.state === "searching" || this.state === "editing" || this.state === "toolRunning") {
			this.applyState("thinking", { force: true });
		}
	}

	onAgentEnd(messages: ReadonlyArray<{ role: string; stopReason?: string }>): void {
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant") {
			this.applyState("idle");
			return;
		}
		if (last.stopReason === "stop" || last.stopReason === "length") {
			this.applyState("complete");
		} else if (last.stopReason === "error" || last.stopReason === "aborted") {
			this.applyState("error");
		} else if (last.stopReason === "toolUse") {
			// More tool work coming — keep the current state.
		} else {
			this.applyState("idle");
		}
	}

	/** Clear timers and reset to idle (session shutdown / session replacement). */
	reset(): void {
		this.clearTransient();
		this.clearReroll();
		this.sink.setWorkingIndicator({ frames: [] });
		this.sink.setWorkingMessage("");
		this.state = "idle";
		this.stateEnteredAt = 0;
		this.currentKaomoji = "";
	}

	/** Final teardown on process shutdown. */
	dispose(): void {
		this.clearTransient();
		this.clearReroll();
	}
}
