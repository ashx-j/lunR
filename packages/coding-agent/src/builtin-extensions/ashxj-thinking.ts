// @ts-nocheck
// Vendored from https://github.com/ashx-j/ashxj-thinking @ 0330a34
// ("Remove custom footer — keep only /thinking command"), single-file ashxj
// convention. lunR patches are marked `// lunr:`.
/**
 * batxj-thinking extension
 *
 * `/thinking [level]` slash command to view or set the reasoning level,
 * plus `/thinking show|hide|toggle` for thinking-block visibility.
 * `/effort` and `/reasoning` are full-parity aliases.
 *
 * Loaded by pi via jiti — no build step, plain TypeScript.
 *
 * NOTE on type imports: this file deliberately declares structural types
 * rather than importing from `@earendil-works/pi-coding-agent` (or
 * `@earendil-works/pi-tui`). pi-coding-agent's `index.d.ts` re-exports
 * from internal `.d.ts` files that contain subpath imports like
 * `@earendil-works/pi-ai/compat`, which fail to resolve under the default
 * `tsc` settings when a file argument is passed (the spec'd
 * `tsc --noEmit index.ts` script). Declaring the types we use inline
 * keeps the typecheck self-contained.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Minimal structural types (see file header for why these are inline)
// ---------------------------------------------------------------------------

/** Mirrored from `@earendil-works/pi-agent-core` `ThinkingLevel`. */
// lunr: added "max" — lunR's ThinkingLevel union includes it.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Mirrored from `@earendil-works/pi-tui` `AutocompleteItem`. */
interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

/** A trimmed view of a `Model` — only the fields the picker reads. */
interface ModelLike {
	id?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

/** A trimmed view of `ExtensionContext` — only the methods/props we use. */
interface ExtensionContextLike {
	mode: "tui" | "rpc" | "json" | "print";
	model: ModelLike | undefined;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	};
}

/** A trimmed view of `ExtensionCommandContext` — only the methods/props we use. */
interface ExtensionCommandContextLike extends ExtensionContextLike {
	getThinkingLevel(): ThinkingLevel;
	/** Reload extensions, skills, prompts, and themes. Re-reads settings.json
	 *  from disk (session.reload() → settingsManager.reload()), so persisted
	 *  runtime settings like `hideThinkingBlock` are live-applied. The captured
	 *  `ctx`/`pi` are stale after this resolves — do not use them afterward. */
	reload(): Promise<void>;
}

/** A trimmed view of `ExtensionAPI` — only the methods we use. */
interface ExtensionAPI {
	registerCommand(name: string, options: {
		description?: string;
		getArgumentCompletions?(prefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
		handler(args: string, ctx: ExtensionCommandContextLike): Promise<void> | void;
	}): void;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
}

// ---------------------------------------------------------------------------
// Thinking level config
// ---------------------------------------------------------------------------

/** All known levels, in display order. */
// lunr: "max" appended (lunR supports it; filtered per-model below when unsupported).
const ALL_LEVELS_7: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Default 5 — used when the active model is undefined (we don't know whether `xhigh`/`max` are supported). */
const ALL_LEVELS_5: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Per-level descriptions. Mirrored from `THINKING_DESCRIPTIONS` in settings-selector.ts. */
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	// lunr: added — mirrors settings-selector.ts.
	max: "Maximum reasoning",
};

/** Returns the levels valid for the given model, in display order. */
function availableLevelsFor(model: ModelLike | undefined): readonly ThinkingLevel[] {
	if (!model) return ALL_LEVELS_5;
	if (model.reasoning === false) return ["off" as const];
	// Filter out levels the model marks as unsupported (null entry).
	return ALL_LEVELS_7.filter((lvl) => {
		const m = model.thinkingLevelMap;
		if (m && Object.prototype.hasOwnProperty.call(m, lvl) && (m as Record<string, string | null>)[lvl] === null) {
			return false;
		}
		return true;
	});
}

/** Builds the inline `<padded level> — <description>` label for a level. */
function formatLevelLabel(level: ThinkingLevel): string {
	return `${level.padEnd(8)} \u2014 ${THINKING_DESCRIPTIONS[level]}`;
}

// ---------------------------------------------------------------------------
// Persisted thinking-block visibility (hideThinkingBlock)
//
// pi has no public extension API to toggle thinking-block visibility live.
// The live in-session toggle is `app.thinking.toggle` (default Ctrl+T) wired to
// `toggleThinkingBlockVisibility()` in interactive-mode.js, which calls
// `SettingsManager.setHideThinkingBlock()` + rebuilds the chat. That method is
// not exposed on ExtensionContext / ExtensionCommandContext / ExtensionAPI.
//
// What extensions CAN do is persist the `hideThinkingBlock` boolean to the
// global agent settings file (`~/.lunr/agent/settings.json`); the
// `SettingsManager` reads it on startup. And because `ctx.reload()` drives
// `session.reload()` → `settingsManager.reload()` (re-reads disk) →
// `restoreChatBeforeSessionStart()` copies the new value into
// `this.hideThinkingBlock` and calls `rebuildChatFromMessages()` (which
// reconstructs every AssistantMessageComponent with the new hide flag), the
// persisted value IS live-applied within the session by `await ctx.reload()`
// (verified against pi 0.80.3). In non-TUI modes `ctx.reload()` is a no-op,
// so the setting simply applies on next start.
//
// The instant keybinding path (Ctrl+T) still works and is the lowest-latency
// toggle; the command is the discoverable, persistable, completions-friendly
// equivalent.
// ---------------------------------------------------------------------------

/** Returns the path to lunR's global agent settings file.
 *  lunr: lunR's agent dir is `~/.lunr/agent` (upstream hardcoded `~/.pi/agent`).
 *  Honors the `PI_CODING_AGENT_DIR` env override like core config.ts does;
 *  a custom agent dir is not exposed to extensions, so this is the only
 *  location we can write to be picked up by
 *  `SettingsManager.tryLoadFromStorage("global")`. */
function agentSettingsPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		// Match core normalizePath(): expand a leading ~ (~/ and, on win32, ~\).
		const home = homedir();
		const expanded =
			envDir === "~"
				? home
				: envDir.startsWith("~/") || (process.platform === "win32" && envDir.startsWith("~\\"))
					? join(home, envDir.slice(2))
					: envDir;
		return join(expanded, "settings.json");
	}
	return join(homedir(), ".lunr", "agent", "settings.json");
}

// ---------------------------------------------------------------------------
// lunR customize bridge for persisted thinking-block visibility.
// When the bridge is present (TUI / gateway sessions), reads/writes go through
// SettingsManager (lockfile + merge). Falls back to direct file I/O when the
// extension loads in a context without the bridge (e.g. upstream pi).
// ---------------------------------------------------------------------------
interface CustomizeBridge {
	getHideThinkingBlock(): boolean;
	setHideThinkingBlock(hide: boolean): void;
}

function getCustomizeBridge(): CustomizeBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/customize")] as CustomizeBridge | undefined;
}

/** Returns the persisted `hideThinkingBlock` value (default false, matching
 *  `getHideThinkingBlock()` which returns `this.settings.hideThinkingBlock ?? false`).
 *  Never throws — on any error (missing file, bad JSON) returns false. */
function readHideThinkingBlock(): boolean {
	const bridge = getCustomizeBridge();
	if (bridge) return bridge.getHideThinkingBlock();
	try {
		const p = agentSettingsPath();
		if (!existsSync(p)) return false;
		const cfg = JSON.parse(readFileSync(p, "utf8")) as { hideThinkingBlock?: boolean };
		return cfg.hideThinkingBlock === true;
	} catch {
		return false;
	}
}

/**
 * Persist `hideThinkingBlock` to the global agent settings file (safe merge).
 *
 * - Preserves all other keys (merge, never overwrite the whole file).
 * - Matches pi's 2-space indentation + trailing newline.
 * - On invalid JSON in the existing file, backs it up to `settings.json.bak`
 *   before writing a fresh file, so a corrupted file is never written back.
 * - Never throws; on any error `ok` is false and the caller notifies the user.
 *
 * `createdFresh` is true when the file didn't exist (or was corrupt and backed
 * up) before this write — the handler uses it to warn that a global settings
 * file was created here.
 */
function writeHideThinkingBlock(hide: boolean): {
	ok: boolean;
	createdFresh: boolean;
} {
	const bridge = getCustomizeBridge();
	if (bridge) {
		try {
			bridge.setHideThinkingBlock(hide);
			return { ok: true, createdFresh: false };
		} catch {
			return { ok: false, createdFresh: false };
		}
	}
	try {
		const p = agentSettingsPath();
		let cfg: Record<string, unknown> = {};
		let createdFresh = false;
		if (existsSync(p)) {
			try {
				cfg = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
			} catch {
				// Existing file is corrupt — back it up, then start fresh.
				try {
					renameSync(p, `${p}.bak`);
				} catch {
					// If backup fails, still proceed to overwrite (best effort).
				}
				cfg = {};
				createdFresh = true;
			}
		} else {
			createdFresh = true;
		}
		cfg.hideThinkingBlock = hide;
		writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
		return { ok: true, createdFresh };
	} catch {
		return { ok: false, createdFresh: false };
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const THINKING_COMMAND_DESCRIPTION =
	"View or set the reasoning level for the current model, or toggle thinking-block visibility with show/hide/toggle";

export default function (pi: ExtensionAPI): void {
	const thinkingSpec = {
		description: THINKING_COMMAND_DESCRIPTION,
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = prefix.toLowerCase();
			// Visibility sub-options first, filtered by prefix, alongside the levels.
			const visibility: AutocompleteItem[] = [
				{ value: "show", label: "show", description: "Show thinking blocks (persisted to settings.json)" },
				{ value: "hide", label: "hide", description: "Hide thinking blocks (persisted to settings.json)" },
				{ value: "toggle", label: "toggle", description: "Toggle thinking blocks (persisted to settings.json)" },
			];
			const levels = availableLevelsFor(currentModel(pi));
			const levelItems = levels
				.filter((lvl) => lvl.startsWith(lower))
				.map((lvl) => ({ value: lvl, label: lvl, description: THINKING_DESCRIPTIONS[lvl] }));
			return [
				...visibility.filter((v) => v.value.startsWith(lower)),
				...levelItems,
			];
		},
		handler: async (args: string, ctx: ExtensionCommandContextLike) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			// ---- Visibility sub-options: /thinking show | hide | toggle ----
			// Caught first so `hide`/`show`/`toggle` are never parsed as levels.
			// Works in every mode: only uses ctx.ui.notify + file I/O + ctx.reload().
			if (lower === "show" || lower === "hide" || lower === "toggle") {
				const current = readHideThinkingBlock();
				const next = lower === "toggle" ? !current : lower === "hide";
				if (next === current) {
					ctx.ui.notify(`Thinking blocks already ${current ? "hidden" : "shown"}.`, "info");
					return;
				}
				const result = writeHideThinkingBlock(next);
				if (!result.ok) {
					// lunr: settings path is lunR's (see agentSettingsPath).
					ctx.ui.notify(`Failed to update ${agentSettingsPath()}`, "error");
					return;
				}
				// The notify MUST run before `await ctx.reload()`: after reload the
				// loader invalidates this `ctx`/`pi` as stale. ctx.reload() live-
				// applies the setting (verified against pi 0.80.3: it drives
				// session.reload() → settingsManager.reload() re-reads disk →
				// restoreChatBeforeSessionStart copies the new value into
				// this.hideThinkingBlock → rebuildChatFromMessages() rebuilds every
				// AssistantMessageComponent with the new hide flag). In non-TUI
				// modes ctx.reload() is a no-op; the setting then applies on next
				// start. The instant keybinding path (Ctrl+T) also still works.
				const verb = next ? "hidden" : "shown";
				const note = result.createdFresh
					? `Thinking blocks ${verb}. (Created ${agentSettingsPath()} with this setting.)`
					: `Thinking blocks ${verb}.`;
				ctx.ui.notify(note, "info");
				await ctx.reload();
				return;
			}

			const levels = availableLevelsFor(ctx.model);
			const currentLevel: ThinkingLevel = pi.getThinkingLevel();
			const validSet = new Set<ThinkingLevel>(levels);

			// No-arg form → open a picker. Skip in non-TUI modes — same pattern
			// as batxj-animations per AGENTS.md §5.
			if (trimmed === "") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`Thinking level: ${currentLevel}`, "info");
					return;
				}
				if (levels.length === 0) {
					ctx.ui.notify("No thinking levels available for this model.", "warning");
					return;
				}
				const options = levels.map((lvl) =>
					(lvl === currentLevel ? "\u25CF " : "  ") + formatLevelLabel(lvl),
				);
				const chosen = await ctx.ui.select(
					`Thinking level (current: ${currentLevel})`,
					options,
				);
				if (chosen === undefined) return;
				// Chosen string starts with the current-marker ("● ") or two-space
				// gutter; strip the prefix and extract the first token (the level).
				const stripped = chosen.replace(/^[\u25CF ]\s?/, "").trimStart();
				const level = stripped.split(/\s+/)[0] as ThinkingLevel;
				if (!validSet.has(level)) {
					ctx.ui.notify(`Unsupported thinking level: ${level}`, "error");
					return;
				}
				if (level === currentLevel) return; // no-op
				pi.setThinkingLevel(level);
				ctx.ui.notify(`Thinking level: ${level}`, "info");
				return;
			}

			// Direct-set form: `/thinking <level>`
			const requested = trimmed.toLowerCase() as ThinkingLevel;
			if (!validSet.has(requested)) {
				ctx.ui.notify(
					`Invalid thinking level: "${trimmed}". Valid: ${levels.join(", ")}`,
					"error",
				);
				return;
			}
			if (requested === currentLevel) {
				ctx.ui.notify(`Thinking level: ${requested} (unchanged)`, "info");
				return;
			}
			pi.setThinkingLevel(requested);
			ctx.ui.notify(`Thinking level: ${requested}`, "info");
		},
	};

	pi.registerCommand("thinking", thinkingSpec);
	// lunr: /effort and /reasoning are full-parity aliases (same handler + completions).
	pi.registerCommand("effort", {
		...thinkingSpec,
		description: `${THINKING_COMMAND_DESCRIPTION} (alias of /thinking)`,
	});
	pi.registerCommand("reasoning", {
		...thinkingSpec,
		description: `${THINKING_COMMAND_DESCRIPTION} (alias of /thinking)`,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the current model from the ExtensionAPI runtime. The spec mentions
 * `pi.getModel()`; pi doesn't expose that name on the API object itself, but
 * the bound `ExtensionContextActions` (which the runtime decorates onto
 * events) does include `getModel()`. We duck-type against the loader so this
 * file stays decoupled from non-public internals. When unavailable (e.g.
 * during autocomplete, before any session has bound), returns undefined and
 * the caller falls back to the default 5-level set.
 */
function currentModel(pi: ExtensionAPI): ModelLike | undefined {
	const fn = (pi as unknown as { getModel?: () => unknown }).getModel;
	if (typeof fn === "function") {
		return fn.call(pi) as ModelLike | undefined;
	}
	return undefined;
}
