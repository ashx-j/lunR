import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface BootScreenRow {
	label: string;
	value: string;
}

/**
 * Startup boot screen: app/version header and CLI details rows,
 * wrapped in an accent2-bordered box that hugs the content width.
 * Renders unbordered when the terminal is too narrow for a frame.
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
		// (Kimi-Code style), sized to the content rather than the full terminal.
		// Too narrow for a frame → render unbordered.
		if (width < 12) {
			return this.renderContent().map((line) => truncateToWidth(line, width));
		}
		const content = this.renderContent().map((line) => truncateToWidth(line, width - 4));
		const contentWidth = Math.max(...content.map((line) => visibleWidth(line)));
		const boxWidth = contentWidth + 4; // "│ " + " │"
		const innerWidth = boxWidth - 4;
		const border = (s: string): string => theme.fg("white", s);
		const rail = (line: string): string => {
			const pad = Math.max(0, innerWidth - visibleWidth(line));
			return border("│ ") + line + " ".repeat(pad) + border(" │");
		};
		const top = border(`╭${"─".repeat(boxWidth - 2)}╮`);
		const bottom = border(`╰${"─".repeat(boxWidth - 2)}╯`);
		return [top, ...content.map(rail), bottom];
	}

	private renderContent(): string[] {
		const lines: string[] = [this.header];
		for (const { label, value } of this.rows) {
			const labelText = `${label}:`;
			lines.push(`${theme.fg("dim", labelText)} ${theme.fg("text", value)}`);
		}
		return lines;
	}
}
