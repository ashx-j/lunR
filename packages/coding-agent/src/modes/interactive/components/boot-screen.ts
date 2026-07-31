import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { MOON_ASCII } from "./boot-ascii.ts";

export interface BootScreenRow {
	label: string;
	value: string;
}

const GAP = 4;
/** Minimum width reserved for the details column before the art is dropped. */
const MIN_DETAILS_WIDTH = 24;

/**
 * Startup boot screen: moon ASCII art on the left, CLI details on the right.
 * Falls back to details-only when the terminal is too narrow for the art.
 * Art lines are never wrapped.
 */
export class BootScreenComponent implements Component {
	/** Pre-styled first line of the details column (logo + version). */
	private readonly header: string;
	private rows: BootScreenRow[];

	constructor(header: string, rows: BootScreenRow[]) {
		this.header = header;
		this.rows = rows;
	}

	/** lunr: allow refreshing rows on session replacement so the model row stays current. */
	updateRows(rows: BootScreenRow[]): void {
		this.rows = rows;
		this.invalidate?.();
	}

	invalidate(): void {
		// No cached state; theme is read fresh on every render.
	}

	render(width: number): string[] {
		// lunr: theme-polish — wrap the boot content in an accent2-bordered box
		// (Kimi-Code style). Too narrow for a frame → render unbordered.
		if (width < 12) {
			return this.renderContent(width);
		}
		const boxWidth = width; // full terminal width
		const innerWidth = boxWidth - 4; // "│ " + " │"
		const content = this.renderContent(innerWidth);
		const border = (s: string): string => theme.fg("white", s);
		const rail = (line: string): string => {
			const pad = Math.max(0, innerWidth - visibleWidth(line));
			return border("│ ") + line + " ".repeat(pad) + border(" │");
		};
		const top = border(`╭${"─".repeat(boxWidth - 2)}╮`);
		const bottom = border(`╰${"─".repeat(boxWidth - 2)}╯`);
		return [top, ...content.map(rail), bottom];
	}

	private renderContent(width: number): string[] {
		const artWidth = Math.max(...MOON_ASCII.map((line) => visibleWidth(line)));
		const showArt = width >= artWidth + GAP + MIN_DETAILS_WIDTH;
		const detailsWidth = showArt ? width - artWidth - GAP : width;

		const details: string[] = [truncateToWidth(this.header, detailsWidth)];
		for (const { label, value } of this.rows) {
			const labelText = `${label}:`;
			const valueWidth = detailsWidth - visibleWidth(labelText) - 1;
			const truncated = truncateToWidth(value, Math.max(0, valueWidth));
			details.push(`${theme.fg("dim", labelText)} ${theme.fg("text", truncated)}`);
		}

		const lines: string[] = [];
		if (showArt) {
			const rowCount = Math.max(MOON_ASCII.length, details.length);
			for (let i = 0; i < rowCount; i++) {
				const detail = i < details.length ? details[i] : undefined;
				const art = i < MOON_ASCII.length ? MOON_ASCII[i] : undefined;
				if (art === undefined) {
					lines.push(" ".repeat(artWidth + GAP) + (detail ?? ""));
					continue;
				}
				const artPart = theme.fg("accent", art) + " ".repeat(Math.max(0, artWidth - visibleWidth(art))); // lunr: theme-polish — moon art stays white (accent); only the box border uses accent2
				lines.push(detail === undefined ? artPart : artPart + " ".repeat(GAP) + detail);
			}
		} else {
			lines.push(...details);
		}
		return lines;
	}
}
