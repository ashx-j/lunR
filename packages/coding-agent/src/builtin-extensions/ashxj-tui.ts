/**
 * ashxj-tui — a custom slim chatbox for pi.
 *
 * Replaces pi-zentui's prompt box + statusline with:
 *   - A rounded prompt box that auto-expands as the typed message wraps to
 *     multiple rows (the sides extend; height grows with content).
 *   - A right-aligned chip on the box's BOTTOM border:
 *       model · provider · effort     (e.g. `glm-5.2 · Ollama Cloud · xhigh`)
 *   - A slim stats line (LSP · MCP · throughput/tokens · context% · ↑↓ · cost)
 *     BELOW the box, not wrapped around the input.
 *   - No session-mode indicator anywhere (pi has no such concept).
 *
 * Loaded by pi via jiti — no build step, plain TypeScript.
 *
 * NOTE on type imports (see `ashxj-thinking`/`simple-memory` for the convention):
 * This file declares structural types inline rather than importing them from
 * `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`.
 * pi-coding-agent's `index.d.ts` re-exports from internal `.d.ts` files that
 * contain subpath imports like `@earendil-works/pi-ai/compat`, which do not
 * resolve under `tsc` with a file argument. We keep the typecheck
 * self-contained with inline types and verify via the included `tsconfig.json`
 * (`moduleResolution: "Bundler"` + `skipLibCheck: true`).
 *
 * The ONE exception is `CustomEditor`, imported as a RUNTIME VALUE from
 * `@earendil-works/pi-coding-agent`. We must `extends` it to inherit pi's app
 * keybindings (escape, ctrl+d, model switching, extension shortcuts) — wrapping
 * would lose those. Under the tsconfig above this resolves as a fully typed
 * class (verified: a zero-arg `new CustomEditor()` probe errors TS2554).
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Minimal structural types (inline — see file header)
// ---------------------------------------------------------------------------

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Trimmed view of pi's `Theme` — only the method we use. */
interface Theme {
	fg(token: string, text: string): string;
}

/** Trimmed view of `pi-tui`'s `TUI` — only the method we use. */
interface TUIHandle {
	requestRender(force?: boolean): void;
}

/** Trimmed view of `pi-tui`'s `EditorTheme`. */
interface EditorThemeLike {
	borderColor: (str: string) => string;
	selectList: unknown;
}

/** Opaque keybindings manager. */
interface KeybindingsLike {
	readonly _?: unknown;
}

/** Trimmed view of an autocomplete list (the editor's private `autocompleteList`). */
interface AutocompleteListLike {
	render(width: number): string[];
}

/** Trimmed view of pi's `ReadonlyFooterDataProvider`. */
interface ReadonlyFooterDataProvider {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

/** Trimmed view of the `getContextUsage` return value. */
interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Trimmed view of an assistant message's usage — the bits we render. */
interface AssistantUsage {
	input: number;
	output: number;
	cost: { total: number };
}

/** Trimmed view of an assistant message. */
interface AssistantMessageLike {
	role: "assistant";
	usage: AssistantUsage;
}

/** Trimmed view of a session entry — only what we iterate over. */
type SessionEntry =
	| { type: "message"; message: AssistantMessageLike }
	| { type: string; message?: unknown };

/** Trimmed view of a `ReadonlySessionManager`. */
interface ReadonlySessionManagerLike {
	getEntries(): readonly SessionEntry[];
	getBranch?(): readonly SessionEntry[];
}

/** Trimmed view of a `Model`. */
interface ModelLike {
	id?: string;
	provider?: string;
	contextWindow?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

interface ExtensionUIContextLike {
	setEditorComponent(factory: EditorFactoryLike | undefined): void;
	setFooter(factory: FooterFactoryLike | undefined): void;
	readonly theme?: Theme;
}

/** Trimmed view of `ExtensionContext`. */
interface ExtensionContextLike {
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	model: ModelLike | undefined;
	sessionManager: ReadonlySessionManagerLike;
	getContextUsage(): ContextUsage | undefined;
	ui: ExtensionUIContextLike;
}

/** Trimmed view of `ExtensionAPI`. */
interface ExtensionAPI {
	getThinkingLevel(): ThinkingLevel;
	on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
}

/** `setEditorComponent` factory shape. */
type EditorFactoryLike = (
	tui: TUIHandle,
	theme: EditorThemeLike,
	keybindings: KeybindingsLike,
) => EditorComponentLike;

interface EditorComponentLike {
	render(width: number): string[];
	getText(): string;
	setText(text: string): void;
	invalidate(): void;
	handleInput?(data: string): void;
}

/** `setFooter` factory shape. */
type FooterFactoryLike = (
	tui: TUIHandle,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => FooterComponentLike;

interface FooterComponentLike {
	render(width: number): string[];
	dispose?(): void;
	invalidate?(): void;
}

// ---------------------------------------------------------------------------
// Display-width helpers (ANSI-aware; CJK-aware)
//
// The editor (`Editor.render`) word-wraps to the given width using grapheme
// width, so each returned line is ≤ that many visual columns. To right-pad a
// line for our box we need a width model that matches closely enough: skip ALL
// escape sequences (SGR color, OSC/DCS/APC/PM/SOS string sequences such as
// pi-tui's `CURSOR_MARKER` `ESC _pi:c BEL`, and two-char escapes), count common
// East-Asian wide ranges as 2, combining marks and variation selectors as 0.
// Handling the string sequences as 0-width is what keeps the right `│` rail
// aligned on the focused (cursor) line — the base editor embeds the marker and
// the TUI strips it at flush time, so we must not count it here.
// ---------------------------------------------------------------------------

function skipAnsi(str: string, pos: number): number {
	if (str.charCodeAt(pos) !== 0x1b) return 0;
	const next = str.charCodeAt(pos + 1);
	// CSI: ESC [ ... <final 0x40-0x7e>
	if (next === 0x5b /* [ */) {
		let j = pos + 2;
		while (j < str.length) {
			const c = str.charCodeAt(j);
			if (c >= 0x40 && c <= 0x7e) return j + 1 - pos;
			j++;
		}
		return str.length - pos; // unterminated; consume the rest
	}
	// String sequences — OSC (]), DCS (P), APC (_), PM (^), SOS (X) — terminated
	// by BEL (0x07) or ST (ESC \). pi-tui's CURSOR_MARKER `ESC _pi:c BEL` is APC;
	// OSC color queries are OSC. All are zero visual width.
	if (
		next === 0x5d /* ] */ ||
		next === 0x50 /* P */ ||
		next === 0x5f /* _ */ ||
		next === 0x5e /* ^ */ ||
		next === 0x58 /* X */
	) {
		let j = pos + 2;
		while (j < str.length) {
			const c = str.charCodeAt(j);
			if (c === 0x07 /* BEL */) return j + 1 - pos;
			if (c === 0x1b && str.charCodeAt(j + 1) === 0x5c /* \ */) return j + 2 - pos;
			j++;
		}
		return str.length - pos; // unterminated; consume the rest
	}
	// Any other ESC sequence: consume ESC + one final byte (e.g. ESC c, ESC \,
	// ESC ( B). A lone trailing ESC with no following byte is 0 width too.
	return Number.isNaN(next) ? 1 : 2;
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

function charWidth(cp: number): number {
	if (cp >= 0x20 && cp < 0x7f) return 1;
	if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0;
	return isWide(cp) ? 2 : 1;
}

/** Visible width of a string, ignoring SGR color codes. */
function displayWidth(str: string): number {
	let w = 0;
	let i = 0;
	while (i < str.length) {
		const skip = skipAnsi(str, i);
		if (skip > 0) {
			i += skip;
			continue;
		}
		const cp = str.codePointAt(i) ?? 0;
		w += charWidth(cp);
		i += cp > 0xffff ? 2 : 1;
	}
	return w;
}

/** Right-pad a (possibly colored) line to `width` visible columns. */
function padRight(line: string, width: number): string {
	const w = displayWidth(line);
	if (w >= width) return line;
	return line + " ".repeat(width - w);
}

/** Truncate a plain (non-ANSI) string to `maxWidth` visible columns. */
function truncatePlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (displayWidth(text) <= maxWidth) return text;
	let out = "";
	let w = 0;
	let i = 0;
	while (i < text.length) {
		const code = text.codePointAt(i) ?? 0;
		const cw = charWidth(code);
		if (w + cw > maxWidth) break;
		out += String.fromCodePoint(code);
		w += cw;
		i += code > 0xffff ? 2 : 1;
	}
	return out;
}

/** Truncate a (possibly ANSI-colored) string to `maxWidth` visible columns,
 *  re-emitting an SGR reset at the cut so styling doesn't bleed. */
function truncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
	if (maxWidth <= 0) return "";
	if (displayWidth(text) <= maxWidth) return text;
	const target = Math.max(0, maxWidth - displayWidth(ellipsis));
	let out = "";
	let w = 0;
	let i = 0;
	while (i < text.length && w < target) {
		const skip = skipAnsi(text, i);
		if (skip > 0) {
			out += text.slice(i, i + skip);
			i += skip;
			continue;
		}
		const code = text.codePointAt(i) ?? 0;
		const cw = charWidth(code);
		if (w + cw > target) break;
		out += String.fromCodePoint(code);
		w += cw;
		i += code > 0xffff ? 2 : 1;
	}
	out += "\x1b[0m";
	return out + ellipsis;
}

/** Clamp each rendered line to `width` visible columns (fallback path). */
function clampLines(lines: string[], width: number): string[] {
	return lines.map((l) => (displayWidth(l) > width ? truncateToWidth(l, width, "") : l));
}

/** Apply a theme `fg` token safely; falls back to plain text. */
function color(theme: Theme | undefined, token: string, text: string): string {
	try {
		return theme?.fg?.(token, text) ?? text;
	} catch {
		return text;
	}
}

// ---------------------------------------------------------------------------
// Stats formatting
// ---------------------------------------------------------------------------

/** Compact token-count formatter: `999`, `1.2k`, `15k`, `1.2M`, `15M`.
 *  Matches pi's FooterComponent / the captured zentui examples
 *  (`↑9.0M ↓112k`, `20%/1.0M`). */
function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Sum input/output tokens and cost across assistant messages in the session. */
function getUsageTotals(ctx: ExtensionContextLike): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
	for (const entry of entries as readonly SessionEntry[]) {
		if (entry.type !== "message") continue;
		const m = entry.message as AssistantMessageLike | undefined;
		if (!m || m.role !== "assistant") continue;
		const u = m.usage;
		if (!u) continue;
		input += u.input ?? 0;
		output += u.output ?? 0;
		cost += u.cost?.total ?? 0;
	}
	return { input, output, cost };
}

// ---------------------------------------------------------------------------
// Provider display label
//
// `ctx.model.provider` is a ProviderId string (e.g. `"ollama-cloud"`), NOT the
// human label. `BUILT_IN_PROVIDER_DISPLAY_NAMES` exists in pi core but is not
// re-exported to extensions, so we derive the label (mirrors zentui's
// `formatProviderLabel`, with an explicit `ollama-cloud` entry).
// ---------------------------------------------------------------------------

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		"ollama-cloud": "Ollama Cloud",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
		mistral: "Mistral",
	};
	return (
		known[provider] ??
		provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

// ---------------------------------------------------------------------------
// The chip: `model · provider · effort`
// ---------------------------------------------------------------------------

function buildChip(ctx: ExtensionContextLike, pi: ExtensionAPI): string {
	const modelId = ctx.model?.id ?? "no-model";
	const providerLabel = formatProviderLabel(ctx.model?.provider);
	const effort = pi.getThinkingLevel();
	return `${modelId} \u00b7 ${providerLabel} \u00b7 ${effort}`;
}

// ---------------------------------------------------------------------------
// The prompt box — `ChatboxEditor extends CustomEditor`
// ---------------------------------------------------------------------------

class ChatboxEditor extends CustomEditor {
	private readonly ctx: ExtensionContextLike;
	private readonly pi: ExtensionAPI;

	constructor(
		tui: TUIHandle,
		theme: EditorThemeLike,
		keybindings: KeybindingsLike,
		ctx: ExtensionContextLike,
		pi: ExtensionAPI,
	) {
		// CustomEditor ctor: (tui, theme, keybindings, options?: EditorOptions).
		// Casts keep the inline types from leaking into the real base signature.
		super(tui as unknown as never, theme as unknown as never, keybindings as unknown as never, {
			paddingX: 0,
		});
		this.ctx = ctx;
		this.pi = pi;
		// `borderColor` is used internally by the base editor; route it through our
		// theme so any internal use stays consistent with the frame.
		this.borderColor = (s: string) => this.color("border", s);
	}

	private color(token: string, text: string): string {
		return color(this.ctx.ui?.theme, token, text);
	}

	override render(width: number): string[] {
		// Too narrow to draw a box — defer to the base editor, clamped.
		if (width <= 4) {
			return clampLines(super.render(width), width);
		}

		// Rails: `│ ` (left) + ` │` (right) => 4 columns of chrome.
		const innerWidth = Math.max(1, width - 4);
		const base = super.render(innerWidth);

		// The base editor appends the autocomplete menu lines (if any) to the END
		// of its render output. Split them off so the body sits inside the box and
		// the autocomplete renders BELOW the bottom border (preserves slash
		// commands). Mirrors zentui's `renderPolishedFrame`.
		const showing = this.isShowingAutocomplete();
		const acList = (this as unknown as { autocompleteList?: AutocompleteListLike }).autocompleteList;
		let acCount = 0;
		if (showing && acList && typeof acList.render === "function") {
			try {
				acCount = acList.render(innerWidth).length;
			} catch {
				acCount = 0;
			}
		}

		// `super.render` returns [base top ─ border, ...wrapped text lines, base
		// bottom ─ border, ...autocomplete lines] — the base editor draws its OWN
		// straight borders and (when active) appends the autocomplete menu. Split the
		// autocomplete off the end, then STRIP the base's first/last lines (its own
		// borders) so we don't render them a second time inside our rounded frame.
		// Mirrors zentui's `editorFrame.slice(1, -1)` (renderPolishedFrame).
		let frame = base;
		let acLines: string[] = [];
		if (acCount > 0 && acCount < frame.length) {
			acLines = frame.slice(frame.length - acCount);
			frame = frame.slice(0, frame.length - acCount);
		}
		const inner = frame.length >= 2 ? frame.slice(1, frame.length - 1) : frame;
		const body = inner.length > 0 ? inner : [""];

		const border = (s: string): string => this.color("border", s);

		// Top border: ╭─…─╮
		const top = border("\u256d" + "\u2500".repeat(width - 2) + "\u256e");

		// Body: │ <padded line> │ (auto-grows with the number of wrapped lines)
		const bodyLines = body.map(
			(ln: string) => border("\u2502 ") + padRight(ln, innerWidth) + border(" \u2502"),
		);

		// Bottom border with the right-aligned chip: ╰─…─ <chip> ─╯
		const bottom = this.renderBottomBorder(width);

		return [top, ...bodyLines, bottom, ...acLines];
	}

	private renderBottomBorder(width: number): string {
		const border = (s: string): string => this.color("border", s);
		let chip = buildChip(this.ctx, this.pi);
		let chipW = displayWidth(chip);

		// Overhead with zero dashes: ╰ + " " + chip + " " + ╯  => 4 columns.
		const overhead = 4;
		if (chipW > width - overhead) {
			chip = truncatePlain(chip, Math.max(0, width - overhead));
			chipW = displayWidth(chip);
		}
		const dashTotal = Math.max(0, width - overhead - chipW);
		// Right-align the chip: a single trailing dash before the corner, the
		// rest lead (right-aligns the chip near the corner).
		const rightDashes = Math.min(dashTotal, 1);
		const leftDashes = dashTotal - rightDashes;

		const left = "\u2570" + "\u2500".repeat(leftDashes) + " ";
		const right = " " + "\u2500".repeat(rightDashes) + "\u256f";
		return border(left) + this.color("dim", chip) + border(right);
	}
}

// ---------------------------------------------------------------------------
// The stats line (footer) — slim, single line, BELOW the box
// ---------------------------------------------------------------------------

function renderStatsLine(
	width: number,
	ctx: ExtensionContextLike,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
): string[] {
	const sep = color(theme, "bright-black", " | ");
	const parts: string[] = [];

	// 1) Extension statuses published by other extensions (rendered as-is,
	//    already styled): LSP (`pi-lsp-extension`), MCP (`pi-mcp-adapter`),
	//    throughput/tokens (`pi-tps-was-taken`). These are NOT on `ctx` directly.
	const statuses = footerData.getExtensionStatuses?.();
	if (statuses && statuses.size > 0) {
		for (const key of ["lsp", "mcp", "tps"] as const) {
			const v = statuses.get(key);
			if (v) parts.push(v);
		}
	}

	// 2) Context usage: `pct/window`.
	const usage = ctx.getContextUsage();
	const win = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
	const pct = usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`;
	const ctxSeg = `${pct}/${formatCount(win)}`;
	const pv = usage?.percent ?? 0;
	if (pv > 90) parts.push(color(theme, "error", ctxSeg));
	else if (pv > 70) parts.push(color(theme, "warning", ctxSeg));
	else parts.push(color(theme, "dim", ctxSeg));

	// 3) Token totals: ↑in ↓out.
	const totals = getUsageTotals(ctx);
	parts.push(color(theme, "dim", `\u2191${formatCount(totals.input)} \u2193${formatCount(totals.output)}`));

	// 4) Cost: $cost.
	parts.push(color(theme, "dim", `$${totals.cost.toFixed(3)}`));

	let line = parts.join(sep);
	if (displayWidth(line) > width) {
		line = truncateToWidth(line, width, "");
	}
	return [line];
}

// ---------------------------------------------------------------------------
// Install / teardown
// ---------------------------------------------------------------------------

function installEditor(
	ctx: ExtensionContextLike,
	pi: ExtensionAPI,
	setRequestor: (r: () => void) => void,
): void {
	if (typeof ctx.ui.setEditorComponent !== "function") return;
	const factory: EditorFactoryLike = (tui, _theme, _keybindings) => {
		setRequestor(() => {
			try {
				tui.requestRender();
			} catch {
				/* ignore */
			}
		});
		return new ChatboxEditor(tui, _theme, _keybindings, ctx, pi);
	};
	ctx.ui.setEditorComponent(factory);
}

function installFooter(
	ctx: ExtensionContextLike,
	setRequestor: (r: () => void) => void,
): void {
	if (typeof ctx.ui.setFooter !== "function") return;
	let disposed = false;
	const factory: FooterFactoryLike = (tui, _theme, _footerData) => {
		setRequestor(() => {
			try {
				tui.requestRender();
			} catch {
				/* ignore */
			}
		});
		return {
			invalidate(): void {
				// render is pure
			},
			dispose(): void {
				disposed = true;
			},
			render(width: number): string[] {
				if (disposed) return [];
				return renderStatsLine(width, ctx, _theme, _footerData);
			},
		};
	};
	ctx.ui.setFooter(factory);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let renderRequestor: (() => void) | undefined = undefined;
	const requestRender = (): void => {
		try {
			renderRequestor?.();
		} catch {
			/* ignore */
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		installEditor(ctx, pi, (r) => {
			renderRequestor = r;
		});
		installFooter(ctx, (r) => {
			if (!renderRequestor) renderRequestor = r;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (typeof ctx.ui?.setEditorComponent === "function") ctx.ui.setEditorComponent(undefined);
		} catch {
			/* ignore */
		}
		try {
			if (typeof ctx.ui?.setFooter === "function") ctx.ui.setFooter(undefined);
		} catch {
			/* ignore */
		}
		renderRequestor = undefined;
	});

	// Re-render triggers: model/provider + effort (chip), and token/cost/context
	// (stats line). Event names match those zentui wires.
	const reRenderEvents = [
		"model_select",
		"thinking_level_select",
		"agent_end",
		"message_end",
		"tool_execution_end",
		"session_compact",
	];
	for (const ev of reRenderEvents) {
		pi.on(ev, () => requestRender());
	}
}