/**
 * ANSI-aware display-width helpers shared by the chatbox editor and the stats
 * footer (ported from the former ashxj-tui baked-in extension).
 *
 * The editor (`Editor.render`) word-wraps to the given width using grapheme
 * width, so each returned line is ≤ that many visual columns. To right-pad a
 * line for the box we need a width model that matches closely enough: skip ALL
 * escape sequences (SGR color, OSC/DCS/APC/PM/SOS string sequences such as
 * pi-tui's `CURSOR_MARKER` `ESC _pi:c BEL`, and two-char escapes), count common
 * East-Asian wide ranges as 2, combining marks and variation selectors as 0.
 * Handling the string sequences as 0-width is what keeps the right `│` rail
 * aligned on the focused (cursor) line — the base editor embeds the marker and
 * the TUI strips it at flush time, so we must not count it here.
 */

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
export function displayWidth(str: string): number {
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
export function padRight(line: string, width: number): string {
	const w = displayWidth(line);
	if (w >= width) return line;
	return line + " ".repeat(width - w);
}

/** Truncate a plain (non-ANSI) string to `maxWidth` visible columns. */
export function truncatePlain(text: string, maxWidth: number): string {
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
export function truncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
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
export function clampLines(lines: string[], width: number): string[] {
	return lines.map((l) => (displayWidth(l) > width ? truncateToWidth(l, width, "") : l));
}

/** Strip ANSI escape sequences so footer statuses can be re-colored uniformly. */
export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Apply a theme `fg` token safely; falls back to plain text. */
export function safeColor(
	theme: { fg(token: string, text: string): string } | undefined,
	token: string,
	text: string,
): string {
	try {
		return theme?.fg?.(token, text) ?? text;
	} catch {
		return text;
	}
}
