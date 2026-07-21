import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * lunR: a faint full-width rule with a centered ☾, rendered between turns.
 *
 * `────── ☾ ──────` — width-aware like DynamicBorder, dimmed via the theme.
 * Respects `outputPad` so the rule aligns with padded chat output.
 */
export class TurnDivider implements Component {
	private outputPad: number;

	constructor(outputPad: number = 1) {
		this.outputPad = outputPad;
	}

	invalidate(): void {
		// No cached state
	}

	render(width: number): string[] {
		const pad = " ".repeat(this.outputPad);
		const inner = Math.max(1, width - this.outputPad * 2);
		const glyph = " ☾ ";
		const glyphWidth = glyph.length;
		if (inner <= glyphWidth) {
			return [`${pad}${theme.fg("dim", glyph.trim())}${pad}`];
		}
		const dashCount = Math.max(1, inner - glyphWidth);
		const leftLen = Math.floor(dashCount / 2);
		const rightLen = dashCount - leftLen;
		const line = `${theme.fg("dim", "─".repeat(leftLen))}${theme.fg("dim", glyph)}${theme.fg(
			"dim",
			"─".repeat(rightLen),
		)}`;
		return [`${pad}${line}${pad}`];
	}
}
