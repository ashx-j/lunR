import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type CopyableTextSegment =
	| { type: "markdown"; text: string }
	| { type: "copyable"; payload: string; complete: boolean; start: number };

interface SourceLine {
	start: number;
	end: number;
	text: string;
}

interface FenceOpening {
	marker: "`" | "~";
	length: number;
	copyable: boolean;
}

function sourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	for (const match of source.matchAll(pattern)) {
		const start = match.index;
		const text = match[1];
		const newline = match[2];
		lines.push({ start, end: start + text.length + newline.length, text });
		if (!newline) break;
	}
	return lines;
}

function parseFenceOpening(line: string): FenceOpening | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return undefined;
	const fence = match[2];
	const info = match[3];
	if (fence[0] === "`" && info.includes("`")) return undefined;
	return {
		marker: fence[0] as "`" | "~",
		length: fence.length,
		copyable: info.trim() === "lunr-copy",
	};
}

function isFenceClosing(line: string, opening: FenceOpening): boolean {
	const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
	if (!match) return false;
	const fence = match[2];
	return fence[0] === opening.marker && fence.length >= opening.length;
}

function payloadEndBeforeClosing(source: string, closingStart: number): number {
	if (closingStart >= 2 && source.slice(closingStart - 2, closingStart) === "\r\n") return closingStart - 2;
	if (closingStart >= 1 && (source[closingStart - 1] === "\n" || source[closingStart - 1] === "\r")) {
		return closingStart - 1;
	}
	return closingStart;
}

export function parseCopyableTextSegments(source: string): CopyableTextSegment[] {
	const lines = sourceLines(source);
	const segments: CopyableTextSegment[] = [];
	let emittedThrough = 0;
	let lineIndex = 0;

	while (lineIndex < lines.length) {
		const openingLine = lines[lineIndex];
		const opening = parseFenceOpening(openingLine.text);
		if (!opening) {
			lineIndex++;
			continue;
		}

		let closingIndex = -1;
		for (let i = lineIndex + 1; i < lines.length; i++) {
			if (isFenceClosing(lines[i].text, opening)) {
				closingIndex = i;
				break;
			}
		}

		if (!opening.copyable) {
			if (closingIndex < 0) break;
			lineIndex = closingIndex + 1;
			continue;
		}

		if (openingLine.start > emittedThrough) {
			segments.push({ type: "markdown", text: source.slice(emittedThrough, openingLine.start) });
		}

		const payloadStart = openingLine.end;
		if (closingIndex < 0) {
			segments.push({
				type: "copyable",
				payload: source.slice(payloadStart),
				complete: false,
				start: openingLine.start,
			});
			return segments;
		}

		const closingLine = lines[closingIndex];
		segments.push({
			type: "copyable",
			payload: source.slice(payloadStart, payloadEndBeforeClosing(source, closingLine.start)),
			complete: true,
			start: openingLine.start,
		});
		emittedThrough = closingLine.end;
		lineIndex = closingIndex + 1;
	}

	if (emittedThrough < source.length) {
		segments.push({ type: "markdown", text: source.slice(emittedThrough) });
	}
	return segments;
}

export type CopyableTextStatus = "idle" | "copying" | "copied" | { error: string };

export class CopyableTextBlockComponent implements Component {
	private renderedRows = 0;
	private readonly payload: string;
	private readonly complete: boolean;
	private readonly outputPad: number;
	private readonly status: CopyableTextStatus;
	private readonly onCopy: () => void;

	constructor(payload: string, complete: boolean, outputPad: number, status: CopyableTextStatus, onCopy: () => void) {
		this.payload = payload;
		this.complete = complete;
		this.outputPad = outputPad;
		this.status = status;
		this.onCopy = onCopy;
	}

	invalidate(): void {
		this.renderedRows = 0;
	}

	render(width: number): string[] {
		if (width <= 0) {
			this.renderedRows = 0;
			return [];
		}

		const horizontalPad = Math.min(this.outputPad, Math.max(0, width - 1));
		const pad = " ".repeat(horizontalPad);
		const contentWidth = Math.max(1, width - horizontalPad * 2);
		const paint = (content: string): string => {
			const line = truncateToWidth(`${pad}${content}`, width, "");
			return theme.bg("userMessageBg", `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`);
		};
		const lines = [paint("")];
		const payloadLines = this.payload.replace(/\t/g, "   ").split("\n");

		for (const payloadLine of payloadLines) {
			for (const wrappedLine of wrapTextWithAnsi(payloadLine, contentWidth)) {
				lines.push(paint(theme.fg("userMessageText", wrappedLine)));
			}
		}

		if (typeof this.status === "object") {
			for (const wrappedLine of wrapTextWithAnsi(`Copy failed: ${this.status.error}`, contentWidth)) {
				lines.push(paint(theme.fg("error", wrappedLine)));
			}
		}
		lines.push(paint(""));
		this.renderedRows = lines.length;
		return lines;
	}

	handleClick(localY: number, width: number, localX?: number): boolean {
		this.render(width);
		if (
			!this.complete ||
			this.status === "copying" ||
			localY < 0 ||
			localY >= this.renderedRows ||
			(localX !== undefined && (localX < 0 || localX >= width))
		) {
			return false;
		}
		this.onCopy();
		return true;
	}
}
