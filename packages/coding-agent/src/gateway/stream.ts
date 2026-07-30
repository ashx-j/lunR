/**
 * lunR: gateway streaming — throttled progressive replies.
 *
 * StreamConsumer accumulates assistant text deltas and mirrors them into a
 * single chat message: the first flush sends a new message, later flushes
 * edit it. Flushes happen at most every intervalMs and only once at least
 * `threshold` new chars have accumulated. finalize() forces a last flush and
 * returns the full text — the caller splits THAT via text.ts for final
 * delivery; the streaming preview itself is truncated to maxPreview-3 + "…".
 *
 * applySilenceFilter() recognizes the [SILENT] / NO_REPLY markers (whole
 * response, or first/last line) and returns null when nothing deliverable
 * remains.
 */

export interface StreamConsumerOptions {
	/** Send the initial message; resolves with the platform message id (null = send failed). */
	sendInitial: (text: string) => Promise<string | null>;
	edit: (messageId: string, text: string) => Promise<void>;
	intervalMs: number;
	threshold: number;
	/** Platform max message length; the streaming preview is truncated to fit. Default 4096. */
	maxPreview?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

const SILENCE_MARKERS = new Set(["[SILENT]", "NO_REPLY"]);

function isMarkerLine(line: string): boolean {
	return SILENCE_MARKERS.has(line.trim());
}

/**
 * Null when the text is just a silence marker (whole, first-line, or
 * last-line); otherwise the text with a leading/trailing marker line
 * stripped (null when nothing else remains).
 */
export function applySilenceFilter(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	if (isMarkerLine(trimmed)) return null;
	const lines = trimmed.split("\n");
	if (lines.length > 0 && isMarkerLine(lines[0])) lines.shift();
	if (lines.length > 0 && isMarkerLine(lines[lines.length - 1])) lines.pop();
	const result = lines.join("\n").trim();
	return result.length > 0 ? result : null;
}

export class StreamConsumer {
	private readonly options: StreamConsumerOptions;
	private buffer = "";
	private flushedLen = 0;
	private messageId: string | null = null;
	private lastFlushAt = 0;
	private chain: Promise<void> = Promise.resolve();
	private readonly maxPreview: number;
	private readonly now: () => number;

	constructor(options: StreamConsumerOptions) {
		this.options = options;
		this.maxPreview = options.maxPreview ?? 4096;
		this.now = options.now ?? (() => Date.now());
	}

	/** Accumulate a delta; schedule a flush when both gates (chars, interval) pass. */
	push(delta: string): void {
		this.buffer += delta;
		if (
			this.buffer.length - this.flushedLen >= this.options.threshold &&
			this.now() - this.lastFlushAt >= this.options.intervalMs
		) {
			this.schedule();
		}
	}

	/** Force a final flush; resolves with the FULL text (caller splits for delivery). */
	async finalize(): Promise<string> {
		this.schedule(true);
		await this.chain;
		return this.buffer;
	}

	/** The platform message id of the preview, when one was successfully sent. */
	get sentMessageId(): string | null {
		return this.messageId;
	}

	/** True when the preview had to truncate the full text (buffer > maxPreview). */
	get truncated(): boolean {
		return this.buffer.length > this.maxPreview;
	}

	/** The streaming preview: full text truncated to maxPreview-3 + "…". */
	private preview(): string {
		if (this.buffer.length <= this.maxPreview) return this.buffer;
		let cut = this.maxPreview - 3;
		// Don't truncate between surrogate halves.
		const code = this.buffer.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		return `${this.buffer.slice(0, cut)}…`;
	}

	private schedule(force = false): void {
		this.chain = this.chain.then(() => this.flush(force)).catch(() => {});
	}

	private async flush(force: boolean): Promise<void> {
		const hasNew = this.buffer.length > this.flushedLen;
		if (!hasNew) return;
		if (!force && this.messageId !== null && this.now() - this.lastFlushAt < this.options.intervalMs) return;
		const text = this.preview();
		if (this.messageId === null) {
			this.messageId = await this.options.sendInitial(text);
			if (this.messageId === null) return; // send failed; retry on the next flush
		} else {
			await this.options.edit(this.messageId, text);
		}
		this.flushedLen = this.buffer.length;
		this.lastFlushAt = this.now();
	}
}
